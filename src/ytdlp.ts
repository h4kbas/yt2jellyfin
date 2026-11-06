import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Config } from './config.js';

export type TrackMeta = {
  id?: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  track?: string;
  uploader?: string;
  channel?: string;
};

export type DownloadResult = { file: string; meta: TrackMeta };

const META_PREFIX = '__META__';
const FILE_PREFIX = '__FILE__';
const PROGRESS_PREFIX = '__PROG__';

function expandHome(file: string): string {
  if (file === '~') return homedir();
  if (file.startsWith('~/')) return join(homedir(), file.slice(2));
  return file;
}

export function downloadTrack(
  cfg: Config,
  url: string,
  onProgress: (percent: string) => void,
): Promise<DownloadResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      '--no-playlist',
      '--newline',
      '--no-warnings',
      // --print turns progress off, force it back so the TUI can show percentages
      '--progress',
      '--print',
      `before_dl:${META_PREFIX}%(.{id,title,artist,album,genre,track,uploader,channel})j`,
      '--progress-template',
      `download:${PROGRESS_PREFIX}%(progress._percent_str)s`,
      '--print',
      `after_move:${FILE_PREFIX}%(filepath)s`,
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '--embed-metadata',
      '--embed-thumbnail',
      '-o',
      '%(id)s.%(ext)s',
      url,
    ];

    const child = spawn(cfg.ytDlpPath, args, {
      cwd: cfg.downloadDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const meta: TrackMeta = {};
    let file = '';
    let stderr = '';

    const stdout = createInterface({ input: child.stdout });
    stdout.on('line', (line) => {
      if (line.startsWith(META_PREFIX)) {
        try {
          Object.assign(meta, JSON.parse(line.slice(META_PREFIX.length)) as TrackMeta);
        } catch {
          // keep going with whatever yt-dlp gave us
        }
        return;
      }
      if (line.startsWith(FILE_PREFIX)) {
        file = line.slice(FILE_PREFIX.length).trim();
        return;
      }
      if (line.startsWith(PROGRESS_PREFIX)) {
        onProgress(line.slice(PROGRESS_PREFIX.length).trim());
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    child.on('error', (error) => {
      rejectPromise(new Error(`failed to run ${cfg.ytDlpPath}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }

      const guessed = meta.id ? resolve(cfg.downloadDir, `${meta.id}.mp3`) : '';
      const result = file ? resolve(expandHome(file)) : guessed;

      if (!result) {
        rejectPromise(new Error('yt-dlp finished but no output file was reported'));
        return;
      }

      resolvePromise({ file: result, meta });
    });
  });
}
