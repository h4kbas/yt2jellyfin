import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Config } from './config.js';

const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const COVER_ART_API = 'https://coverartarchive.org';
const ART_TIMEOUT_MS = 15_000;
const ART_USER_AGENT = 'yt2jellyfin (+https://github.com/h4kbas/yt2jellyfin)';
const MAX_CANDIDATES = 5;
const MAX_COVER_ART = 2;

export type ArtCandidate = {
  key: string;
  label: string;
  detail: string;
  source: 'embedded' | 'coverart';
  bytes: Buffer;
  mime: string;
};

type ReleaseGroup = {
  id: string;
  title: string;
  year: string | null;
  score: number;
};

function runPipe(command: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }
      resolvePromise(Buffer.concat(output));
    });

    if (input) child.stdin?.end(input);
  });
}

function imageMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return 'image/jpeg';
}

// yt-dlp already embedded the video thumbnail in the mp3, ffmpeg can hand it back.
async function extractEmbeddedArt(cfg: Config, file: string): Promise<ArtCandidate | null> {
  try {
    const bytes = await runPipe(cfg.ffmpegPath, [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-c',
      'copy',
      '-f',
      'image2pipe',
      'pipe:1',
    ]);

    if (bytes.length === 0) return null;

    return {
      key: 'embedded',
      label: 'YouTube thumbnail',
      detail: 'embedded in the mp3',
      source: 'embedded',
      bytes,
      mime: imageMime(bytes),
    };
  } catch {
    return null;
  }
}

async function searchReleaseGroups(album: string, artist: string): Promise<ReleaseGroup[]> {
  if (album.trim().length === 0) return [];

  const conditions = [
    `releasegroup:"${album.replace(/"/g, ' ').trim()}"`,
    'primarytype:Album',
  ];
  if (artist.trim().length > 0) conditions.push(`artist:"${artist.replace(/"/g, ' ').trim()}"`);

  const query = new URLSearchParams({ query: conditions.join(' AND '), fmt: 'json', limit: '5' });
  const response = await fetch(`${MUSICBRAINZ_API}/release-group/?${query}`, {
    headers: { 'User-Agent': ART_USER_AGENT },
    signal: AbortSignal.timeout(ART_TIMEOUT_MS),
  });
  if (!response.ok) return [];

  const body = (await response.json()) as {
    'release-groups'?: {
      id: string;
      title: string;
      score?: number;
      'first-release-date'?: string;
    }[];
  };

  return (body['release-groups'] ?? [])
    .map((group) => ({
      id: group.id,
      title: group.title,
      year: group['first-release-date']?.slice(0, 4) ?? null,
      score: group.score ?? 0,
    }))
    .filter((group) => group.score >= 75)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

async function fetchCoverArt(releaseGroupId: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const response = await fetch(`${COVER_ART_API}/release-group/${releaseGroupId}/front-500`, {
    headers: { 'User-Agent': ART_USER_AGENT },
    signal: AbortSignal.timeout(ART_TIMEOUT_MS),
  });
  if (!response.ok) return null;

  const mime = response.headers.get('content-type') ?? '';
  if (!mime.startsWith('image/')) return null;

  return { bytes: Buffer.from(await response.arrayBuffer()), mime };
}

type ITunesResult = {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  collectionId?: number;
  releaseDate?: string;
  artworkUrl100?: string;
};

// "Artist - Song (Official Video)" -> "Song"; YouTube titles are noisy.
function cleanTitle(title: string): string {
  const withoutBrackets = title
    .replace(/\((?:official|lyrics?|audio|video|visuali[sz]er|hd|hq|4k)[^)]*\)/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ');
  const parts = withoutBrackets.split(' - ');
  const song = parts.length > 1 ? parts.slice(1).join(' - ') : withoutBrackets;

  return song.replace(/\bft\..*$/i, '').replace(/\s+/g, ' ').trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanArtist(artist: string): string {
  return artist.replace(/\s*-\s*topic$/i, '').trim();
}

// iTunes has broad album art coverage and needs no key. Used when the album
// field is empty or Cover Art Archive has nothing for the album.
async function searchItunes(
  artist: string,
  title: string,
  album: string,
): Promise<{ label: string; detail: string; bytes: Buffer; mime: string }[]> {
  const wantedTitle = normalize(cleanTitle(title));
  const wantedArtist = normalize(cleanArtist(artist));
  const wantedAlbum = normalize(album);
  const term = [cleanArtist(artist), cleanTitle(title)].filter(Boolean).join(' ').trim();
  if (term.length === 0) return [];

  const query = new URLSearchParams({ term, entity: 'song', limit: '25' });
  const response = await fetch(`https://itunes.apple.com/search?${query}`, {
    headers: { 'User-Agent': ART_USER_AGENT },
    signal: AbortSignal.timeout(ART_TIMEOUT_MS),
  });
  if (!response.ok) return [];

  const body = (await response.json()) as { results?: ITunesResult[] };
  const results = body.results ?? [];

  const scored = results.map((result) => {
    const track = normalize(result.trackName ?? '');
    const artistName = normalize(result.artistName ?? '');
    const collection = normalize(result.collectionName ?? '');

    let score = 0;
    if (wantedTitle && track === wantedTitle) score += 4;
    else if (wantedTitle && (track.includes(wantedTitle) || wantedTitle.includes(track))) score += 2;
    if (wantedAlbum && collection === wantedAlbum) score += 3;
    if (wantedAlbum && collection.includes(wantedAlbum)) score += 1;

    return { result, score, artistMatch: wantedArtist.length > 0 && artistName.includes(wantedArtist) };
  });

  // prefer results by the correct artist, but keep working when yt-dlp gave junk
  const artistMatches = scored.filter((entry) => entry.artistMatch);
  const pool = artistMatches.length > 0 ? artistMatches : scored;

  const picked: ITunesResult[] = [];
  const seenCollections = new Set<string>();
  for (const entry of [...pool].sort((a, b) => b.score - a.score)) {
    const collection = normalize(entry.result.collectionName ?? '');
    if (collection.length === 0 || seenCollections.has(collection)) continue;
    seenCollections.add(collection);
    picked.push(entry.result);
    if (picked.length >= 3) break;
  }

  const covers: { label: string; detail: string; bytes: Buffer; mime: string }[] = [];
  for (const result of picked) {
    const artwork = result.artworkUrl100?.replace('100x100bb', '600x600bb');
    if (!artwork) continue;

    const image = await fetch(artwork, {
      headers: { 'User-Agent': ART_USER_AGENT },
      signal: AbortSignal.timeout(ART_TIMEOUT_MS),
    });
    if (!image.ok) continue;

    const mime = image.headers.get('content-type') ?? '';
    if (!mime.startsWith('image/')) continue;

    const year = result.releaseDate?.slice(0, 4);
    covers.push({
      label: result.collectionName?.trim() || cleanTitle(title) || 'iTunes artwork',
      detail: `iTunes${year ? ` · ${year}` : ''}`,
      bytes: Buffer.from(await image.arrayBuffer()),
      mime,
    });
  }

  return covers;
}

export async function loadArtCandidates(
  cfg: Config,
  track: { file: string; title: string; album: string; artist: string },
): Promise<ArtCandidate[]> {
  const candidates: ArtCandidate[] = [];
  const seen = new Set<string>();
  const seenLabels = new Set<string>();

  const embedded = await extractEmbeddedArt(cfg, track.file);
  if (embedded) {
    candidates.push(embedded);
    seen.add(createHash('sha1').update(embedded.bytes).digest('hex'));
    seenLabels.add(normalize(embedded.label));
  }

  const groups = await searchReleaseGroups(track.album, track.artist);
  for (const group of groups) {
    if (candidates.length >= MAX_COVER_ART + 1) break;

    const cover = await fetchCoverArt(group.id);
    if (!cover) continue;

    const hash = createHash('sha1').update(cover.bytes).digest('hex');
    const label = normalize(group.title);
    if (seen.has(hash) || seenLabels.has(label)) continue;

    seen.add(hash);
    seenLabels.add(label);
    candidates.push({
      key: `caa:${group.id}`,
      label: group.title,
      detail: `Cover Art Archive${group.year ? ` · ${group.year}` : ''}`,
      source: 'coverart',
      bytes: cover.bytes,
      mime: cover.mime,
    });
  }

  if (candidates.length < MAX_CANDIDATES) {
    const itunes = await searchItunes(track.artist, track.title, track.album);
    for (const cover of itunes) {
      if (candidates.length >= MAX_CANDIDATES) break;

      const hash = createHash('sha1').update(cover.bytes).digest('hex');
      const label = normalize(cover.label);
      if (seen.has(hash) || seenLabels.has(label)) continue;

      seen.add(hash);
      seenLabels.add(label);
      candidates.push({
        key: `itunes:${hash.slice(0, 12)}`,
        label: cover.label,
        detail: cover.detail,
        source: 'coverart',
        bytes: cover.bytes,
        mime: cover.mime,
      });
    }
  }

  return candidates;
}

// Inline terminals take png, so re-encode whatever the provider returned.
export async function toPng(ffmpegPath: string, bytes: Buffer, width: number): Promise<Buffer> {
  return runPipe(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-vf',
      `scale=${width}:-1`,
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ],
    bytes,
  );
}
