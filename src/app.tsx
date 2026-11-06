import { useRef, useState } from 'react';
import { useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { loadConfig, saveConfig, type Config } from './config.js';
import { downloadTrack, type TrackMeta } from './ytdlp.js';
import { applyTags } from './media.js';
import { refreshLibrary, tagUploadedFiles, uploadToServer } from './jellyfin.js';

type Status = 'queued' | 'downloading' | 'downloaded' | 'uploading' | 'uploaded' | 'error';

type Fields = {
  title: string;
  artist: string;
  album: string;
  genre: string;
};

type Item = Fields & {
  url: string;
  status: Status;
  progress: string;
  file?: string;
  error?: string;
};

type Phase = 'setup' | 'urls' | 'downloading' | 'review' | 'done';

const SETUP_FIELDS: { key: keyof Config; label: string; secret?: boolean }[] = [
  { key: 'jellyfinUrl', label: 'Jellyfin url' },
  { key: 'jellyfinApiKey', label: 'API key', secret: true },
  { key: 'jellyfinUploadDir', label: 'Server dir' },
  { key: 'downloadDir', label: 'Download dir' },
  { key: 'ytDlpPath', label: 'yt-dlp' },
  { key: 'ffmpegPath', label: 'ffmpeg' },
];

const FIELD_ORDER: (keyof Fields)[] = ['title', 'artist', 'album', 'genre'];
const FIELD_LABELS: Record<keyof Fields, string> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  genre: 'Genre',
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusIcon(status: Status): string {
  if (status === 'uploaded') return '[ok]';
  if (status === 'error') return '[!!]';
  if (status === 'downloading' || status === 'uploading') return '[..]';
  return '[ ]';
}

function statusColor(status: Status): string | undefined {
  if (status === 'uploaded') return 'green';
  if (status === 'error') return 'red';
  if (status === 'downloading' || status === 'uploading') return 'yellow';
  return undefined;
}

function statusText(item: Item): string {
  if (item.status === 'downloading') {
    return item.progress ? `downloading ${item.progress}` : 'downloading';
  }
  if (item.status === 'error') return `failed: ${item.error ?? 'unknown error'}`;
  if (item.status === 'downloaded') return 'ready to tag';
  return item.status;
}

function defaults(meta: TrackMeta, file: string): Fields {
  const base = file.split('/').pop() ?? file;
  const title = (meta.track || meta.title || base.replace(/\.mp3$/i, '')).trim();
  const artist = (meta.artist || meta.channel || meta.uploader || '').trim();

  return {
    title,
    artist,
    album: (meta.album ?? '').trim(),
    genre: (meta.genre ?? '').trim(),
  };
}

export function App() {
  const loaded = useRef(loadConfig()).current;
  const { exit } = useApp();

  const [config, setConfig] = useState<Config>(loaded.config);
  const cfg = config;
  const [phase, setPhase] = useState<Phase>(loaded.needsSetup ? 'setup' : 'urls');
  const [draft, setDraft] = useState<Config>(loaded.config);
  const [setupIndex, setSetupIndex] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [reviewIndex, setReviewIndex] = useState(0);
  const [fieldIndex, setFieldIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const urlsRef = useRef<string[]>([]);
  const busyRef = useRef(false);
  // Mirror of the items state kept in a ref so async steps read fresh statuses
  // without waiting for React to commit the last batched update.
  const itemsRef = useRef<Item[]>(items);

  function commit(next: Item[]) {
    itemsRef.current = next;
    setItems(next);
  }

  function updateItem(index: number, patch: Partial<Item>) {
    commit(itemsRef.current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function start() {
    if (itemsRef.current.length === 0) {
      setMessage('paste a youtube url first');
      return;
    }

    urlsRef.current = itemsRef.current.map((item) => item.url);
    setMessage('');
    commit(
      itemsRef.current.map((item) => ({
        ...item,
        status: 'queued',
        progress: '',
        error: undefined,
      })),
    );
    setPhase('downloading');
  }

  function submitSetup(index: number) {
    if (index < SETUP_FIELDS.length - 1) {
      setSetupIndex(index + 1);
      return;
    }

    const next: Config = {
      jellyfinUrl: draft.jellyfinUrl.trim().replace(/\/+$/, ''),
      jellyfinApiKey: draft.jellyfinApiKey.trim(),
      jellyfinUploadDir: draft.jellyfinUploadDir.trim(),
      downloadDir: draft.downloadDir.trim(),
      ytDlpPath: draft.ytDlpPath.trim() || 'yt-dlp',
      ffmpegPath: draft.ffmpegPath.trim() || 'ffmpeg',
    };

    if (!/^https?:\/\//i.test(next.jellyfinUrl)) {
      setMessage('jellyfin url must start with http:// or https://');
      setSetupIndex(0);
      return;
    }
    if (next.jellyfinApiKey.length === 0) {
      setMessage('api key is required');
      setSetupIndex(1);
      return;
    }
    if (next.jellyfinUploadDir.length === 0 || next.downloadDir.length === 0) {
      setMessage('upload and download dirs cannot be empty');
      return;
    }

    try {
      saveConfig(next);
      setConfig(next);
      setDraft(next);
      setMessage(`config saved to ${loaded.path}`);
      setPhase('urls');
    } catch (error) {
      setMessage(`could not save config: ${errorMessage(error)}`);
    }
  }

  function submitUrls(value: string) {
    const tokens = value.split(/\s+/).filter(Boolean);
    const urls = tokens.filter((token) => /^https?:\/\//i.test(token));

    if (urls.length === 0) {
      if (tokens.length === 0 && itemsRef.current.length > 0) {
        start();
      } else {
        setMessage('not a url: paste a youtube link');
      }
      return;
    }

    const fresh = urls.filter((url) => !itemsRef.current.some((item) => item.url === url));
    if (fresh.length === 0) {
      setMessage('url already in the list');
      return;
    }

    commit([
      ...itemsRef.current,
      ...fresh.map((url) => ({
        url,
        status: 'queued' as Status,
        progress: '',
        title: '',
        artist: '',
        album: '',
        genre: '',
      })),
    ]);
    setInput('');
    setMessage('');
  }

  useEffect(() => {
    if (phase !== 'downloading') return;

    let cancelled = false;

    void (async () => {
      for (let i = 0; i < urlsRef.current.length && !cancelled; i++) {
        updateItem(i, { status: 'downloading', progress: '', error: undefined });

        try {
          const { file, meta } = await downloadTrack(cfg, urlsRef.current[i], (percent) => {
            updateItem(i, { progress: percent });
          });
          updateItem(i, { status: 'downloaded', file, ...defaults(meta, file) });
        } catch (error) {
          updateItem(i, { status: 'error', error: errorMessage(error) });
        }
      }

      if (cancelled) return;

      const first = itemsRef.current.findIndex((item) => item.status === 'downloaded');
      if (first === -1) {
        setMessage('nothing downloaded');
        setPhase('done');
        return;
      }

      setReviewIndex(first);
      setFieldIndex(0);
      setPhase('review');
    })();

    return () => {
      cancelled = true;
    };
  }, [phase]);

  async function advance(from: number) {
    const next = itemsRef.current.findIndex(
      (item, i) => i > from && item.status === 'downloaded',
    );

    if (next !== -1) {
      setReviewIndex(next);
      setFieldIndex(0);
      return;
    }

    try {
      await refreshLibrary(cfg);
      const tracks = itemsRef.current
        .filter((item) => item.status === 'uploaded' && item.file)
        .map((item) => ({ file: item.file as string, title: item.title }));
      const { missed } = await tagUploadedFiles(cfg, tracks);
      setMessage(
        missed > 0
          ? `upload done, library scan started, YouTube tag missed on ${missed}`
          : 'upload done, YouTube tag added, library scan started',
      );
    } catch (error) {
      setMessage(`upload done, refresh failed: ${errorMessage(error)}`);
    }
    setPhase('done');
  }

  async function acceptAndUpload() {
    if (busyRef.current) return;

    const index = reviewIndex;
    const item = itemsRef.current[index];
    if (!item || item.status !== 'downloaded' || !item.file) return;

    const values = {
      title: item.title.trim(),
      artist: item.artist.trim(),
      album: item.album.trim(),
      genre: item.genre.trim(),
    };

    if (values.title.length === 0) {
      setMessage('title cannot be empty');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setMessage('');
    updateItem(index, { status: 'uploading' });

    try {
      const tagged = await applyTags(cfg, item.file, values);
      updateItem(index, { file: tagged });
      await uploadToServer(cfg, tagged);
      updateItem(index, { status: 'uploaded' });
      await advance(index);
    } catch (error) {
      updateItem(index, { status: 'error', error: errorMessage(error) });
      await advance(index);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function submitField(index: number) {
    if (index < FIELD_ORDER.length - 1) {
      setFieldIndex(index + 1);
    } else {
      void acceptAndUpload();
    }
  }

  useInput((_input, key) => {
    if (phase === 'done') {
      if (key.return || key.escape) exit();
      return;
    }

    if (phase === 'setup') {
      if (key.tab) {
        const delta = key.shift ? -1 : 1;
        setSetupIndex((prev) => (prev + delta + SETUP_FIELDS.length) % SETUP_FIELDS.length);
      }
      return;
    }

    if (phase !== 'review') return;

    if (key.tab) {
      const delta = key.shift ? -1 : 1;
      setFieldIndex(
        (prev) => (prev + delta + FIELD_ORDER.length) % FIELD_ORDER.length,
      );
      return;
    }

    if (key.escape) {
      const item = itemsRef.current[reviewIndex];
      if (!item || item.status !== 'downloaded') return;
      updateItem(reviewIndex, { status: 'error', error: 'skipped' });
      void advance(reviewIndex);
    }
  });

  const current = items[reviewIndex];
  const uploaded = items.filter((item) => item.status === 'uploaded').length;
  const failed = items.filter((item) => item.status === 'error').length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold color="cyan">
          yt2jellyfin
        </Text>
        <Text dimColor>
          {'  '}
          {cfg.jellyfinUrl}
          {' · '}
          {cfg.jellyfinUploadDir}
        </Text>
      </Text>
      <Text dimColor>config {loaded.path}</Text>
      {phase !== 'setup' && !cfg.jellyfinApiKey && (
        <Text color="yellow">
          jellyfin api key missing: set YTJ_JELLYFIN_API_KEY or edit the config file
        </Text>
      )}

      {phase === 'setup' ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text>first run: check the jellyfin settings, defaults are prefilled</Text>
          {SETUP_FIELDS.map((field, index) => (
            <Box key={field.key}>
              <Box width={15}>
                <Text color={index === setupIndex ? 'green' : undefined}>{field.label}</Text>
              </Box>
              {index === setupIndex ? (
                <TextInput
                  value={draft[field.key]}
                  mask={field.secret ? '*' : undefined}
                  onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
                  onSubmit={() => submitSetup(index)}
                />
              ) : (
                <Text dimColor={draft[field.key].length === 0}>
                  {field.secret && draft[field.key].length > 0
                    ? '*'.repeat(8)
                    : draft[field.key] || '-'}
                </Text>
              )}
            </Box>
          ))}
          <Text dimColor>tab/shift+tab moves field · enter saves on the last field</Text>
        </Box>
      ) : phase === 'urls' ? (
        <Box flexDirection="column" marginTop={1}>
          {items.map((item, index) => (
            <Text key={item.url}>
              {index + 1}. {item.url}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color="green">url </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={submitUrls}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </Box>
          <Text dimColor>enter adds url · enter on empty line downloads all · ctrl+c quits</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {items.map((item, index) => (
            <Text key={item.url} color={statusColor(item.status)}>
              {statusIcon(item.status)} {index + 1}. {item.title || item.url}
              <Text dimColor>{'  '}{statusText(item)}</Text>
            </Text>
          ))}
        </Box>
      )}

      {phase === 'review' && current && current.status !== 'uploaded' && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text dimColor>{current.url}</Text>
          {FIELD_ORDER.map((name, index) => (
            <Box key={name}>
              <Box width={9}>
                <Text color={index === fieldIndex ? 'green' : undefined}>{FIELD_LABELS[name]}</Text>
              </Box>
              {index === fieldIndex && current.status === 'downloaded' ? (
                <TextInput
                  value={current[name]}
                  onChange={(value) => updateItem(reviewIndex, { [name]: value } as Partial<Item>)}
                  onSubmit={() => submitField(index)}
                />
              ) : (
                <Text dimColor={current[name].length === 0}>{current[name] || '-'}</Text>
              )}
            </Box>
          ))}
          <Text dimColor>
            {current.status === 'uploading'
              ? 'uploading...'
              : busy
                ? 'refreshing library...'
                : 'tab/shift+tab moves field · enter saves and uploads · esc skips track'}
          </Text>
        </Box>
      )}

      {phase === 'done' && (
        <Box marginTop={1}>
          <Text>
            uploaded {uploaded} · failed {failed}
          </Text>
        </Box>
      )}

      {message.length > 0 && <Text color="yellow">{message}</Text>}
      {phase === 'done' && <Text dimColor>enter exits</Text>}
    </Box>
  );
}
