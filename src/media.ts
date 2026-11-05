import { execFile } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './config.js';

const execFileAsync = promisify(execFile);

export type TagValues = {
  title: string;
  artist: string;
  album: string;
  genre: string;
};

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');

  return cleaned.slice(0, 150).trim() || 'track';
}

export function trackFileName(title: string, artist: string): string {
  const safeTitle = sanitizeFileName(title);
  const safeArtist = artist.trim().length > 0 ? sanitizeFileName(artist) : '';
  return safeArtist.length > 0 ? `${safeArtist} - ${safeTitle}.mp3` : `${safeTitle}.mp3`;
}

// Rewrites the mp3 tags so Jellyfin does not index YouTube junk (video title as
// title, channel name as artist, description/purl as extra metadata).
export async function applyTags(
  cfg: Config,
  file: string,
  values: TagValues,
): Promise<string> {
  const target = join(dirname(file), trackFileName(values.title, values.artist));
  const temp = `${file}.tagged.mp3`;

  const args = [
    '-y',
    '-i',
    file,
    '-map',
    '0',
    '-c',
    'copy',
    '-map_metadata',
    '-1',
    '-metadata',
    `title=${values.title}`,
    '-metadata',
    `artist=${values.artist}`,
  ];

  if (values.album.trim().length > 0) {
    args.push('-metadata', `album=${values.album}`);
  }
  if (values.genre.trim().length > 0) {
    args.push('-metadata', `genre=${values.genre}`);
  }

  await execFileAsync(cfg.ffmpegPath, [...args, temp]);

  if (resolve(target) !== resolve(file)) {
    await rm(file, { force: true });
  }
  await rename(temp, target);

  return target;
}
