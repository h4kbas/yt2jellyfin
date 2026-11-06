const CHUNK_SIZE = 4096;
const MAX_CARD_COLS = 16;
const MIN_CARD_COLS = 10;
const GAP_COLS = 2;
const LABEL_ROWS = 1;
const MIN_COLUMNS = 40;
const SELECTED_COLOR = '\x1b[38;5;82m';
const IDLE_COLOR = '\x1b[38;5;244m';
const RESET = '\x1b[0m';

export type PreviewCard = {
  key: string;
  label: string;
  png?: Buffer;
};

type Grid = {
  row: number;
  col: number;
  columns: number;
  rows: number;
  totalCols: number;
  totalRows: number;
};

let lastGrid: Grid | null = null;
let lastImageIds: number[] = [];
let nextImageId = 1;

// Kitty / iTerm2 graphics: WezTerm, kitty, ghostty, iTerm2. Everything else
// (Terminal.app, CI) gets the list without pictures.
export function supportsInlineImages(): boolean {
  const program = process.env.TERM_PROGRAM ?? '';
  const term = process.env.TERM ?? '';

  // tmux does not sync its cursor to the outer terminal before passthrough
  // chunks run, images land in the wrong cells
  if (process.env.TMUX !== undefined) return false;

  if (['WezTerm', 'iTerm.app', 'ghostty', 'kitty'].includes(program)) return true;
  if (term.includes('kitty')) return true;

  return process.env.WEZTERM_PANE !== undefined || process.env.KITTY_WINDOW_ID !== undefined;
}

type CardLayout = {
  cardCols: number;
  cardRows: number;
};

// One row, side by side. Cards shrink a bit when the terminal is narrow.
function cardLayout(cards: number): CardLayout | null {
  const width = process.stdout.columns ?? 0;
  if (cards <= 0 || width < MIN_COLUMNS) return null;

  const available = width - 4;
  if (available < cards * (MIN_CARD_COLS + GAP_COLS) - GAP_COLS) return null;

  const cardCols = Math.min(
    MAX_CARD_COLS,
    Math.floor((available - (cards - 1) * GAP_COLS) / cards),
  );
  // keep the picture roughly square: cells are about half as wide as they are tall
  const innerRows = Math.max(4, Math.round((cardCols - 2) * 0.47));

  return { cardCols, cardRows: innerRows + 2 };
}

export function cardGridHeight(cards: number): number {
  const layout = cardLayout(cards);
  if (!layout) return 0;

  return layout.cardRows + LABEL_ROWS;
}

function wrap(sequence: string): string {
  if (process.env.TMUX === undefined) return sequence;

  // tmux only forwards escape sequences inside its passthrough wrapper.
  return `\x1bPtmux;\x1b${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

function deleteImage(imageId: number): string {
  return wrap(`\x1b_Ga=d,d=i,i=${imageId}\x1b\\`);
}

function clearRows(grid: Grid): string {
  let sequence = '';
  for (let index = 0; index < grid.totalRows; index++) {
    sequence += `\x1b[${grid.row + index};${grid.col}H\x1b[2K`;
  }
  return sequence;
}

export function clearPreview(): boolean {
  if (lastGrid === null) return false;

  let sequence = '\x1b[s';
  for (const imageId of lastImageIds) sequence += deleteImage(imageId);
  sequence += `${clearRows(lastGrid)}\x1b[u`;
  process.stdout.write(sequence);

  lastGrid = null;
  lastImageIds = [];
  return true;
}

function displayImage(png: Buffer, row: number, col: number, cols: number, rows: number): string {
  const imageId = nextImageId++;
  const base64 = png.toString('base64');
  let sequence = `\x1b[${row};${col}H`;
  let first = true;

  for (let index = 0; index < base64.length; index += CHUNK_SIZE) {
    const chunk = base64.slice(index, index + CHUNK_SIZE);
    const last = index + CHUNK_SIZE >= base64.length;
    const params = first
      ? `f=100,a=T,t=d,C=1,i=${imageId},c=${cols},r=${rows}${last ? '' : ',m=1'}`
      : `m=${last ? 0 : 1}`;
    const graphics = `\x1b_G${params};${chunk}\x1b\\`;
    // tmux does not sync its cursor to the outer terminal before a passthrough
    // chunk runs, so move the real cursor from inside the wrapper
    sequence += wrap(first ? `\x1b[${row};${col}H${graphics}` : graphics);
    first = false;
  }

  lastImageIds.push(imageId);
  return sequence;
}

function text(row: number, col: number, value: string, color: string): string {
  return `\x1b[${row};${col}H${color}${value}${RESET}`;
}

function truncate(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

// Bottom-aligned grid of image cards: thumbnails with a border, label below,
// and an empty card for "no picture". The app keeps its own content above.
export function drawCardPicker(cards: PreviewCard[], selected: number, topRow?: number): boolean {
  clearPreview();

  const terminalRows = process.stdout.rows ?? 0;
  const terminalColumns = process.stdout.columns ?? 0;
  const layout = cardLayout(cards.length);
  if (!layout) return false;

  const { cardCols, cardRows } = layout;
  const totalCols = cards.length * cardCols + (cards.length - 1) * GAP_COLS;
  const totalRows = cardRows + LABEL_ROWS;
  const row = topRow ?? terminalRows - totalRows;
  const col = Math.floor((terminalColumns - totalCols) / 2) + 1;

  if (row < 1 || row + totalRows - 1 > terminalRows) return false;

  const grid: Grid = { row, col, columns: cards.length, rows: 1, totalCols, totalRows };
  let sequence = '\x1b[s';

  cards.forEach((card, index) => {
    const boxRow = row;
    const boxCol = col + index * (cardCols + GAP_COLS);
    const inner = cardCols - 2;
    const color = index === selected ? SELECTED_COLOR : IDLE_COLOR;

    sequence += text(boxRow, boxCol, `╭${'─'.repeat(inner)}╮`, color);
    sequence += text(boxRow + cardRows - 1, boxCol, `╰${'─'.repeat(inner)}╯`, color);

    for (let offset = 1; offset < cardRows - 1; offset++) {
      sequence += text(boxRow + offset, boxCol, '│', color);
      sequence += text(boxRow + offset, boxCol + cardCols - 1, '│', color);
    }

    if (card.png) {
      sequence += displayImage(card.png, boxRow + 1, boxCol + 1, inner, cardRows - 2);
    } else {
      const placeholder = 'no art';
      const placeholderRow = boxRow + Math.floor(cardRows / 2);
      const placeholderCol = boxCol + 1 + Math.floor((inner - placeholder.length) / 2);
      sequence += text(placeholderRow, placeholderCol, placeholder, IDLE_COLOR);
    }

    const label = truncate(card.label, cardCols);
    const labelCol = boxCol + Math.max(0, Math.floor((cardCols - label.length) / 2));
    sequence += text(boxRow + cardRows, labelCol, label, color);
  });

  sequence += '\x1b[u';
  process.stdout.write(sequence);

  lastGrid = grid;
  return true;
}
