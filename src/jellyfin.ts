import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ArtCandidate } from './artwork.js';
import type { Config } from './config.js';

// RemoteUpload plugin: https://github.com/grandguyjs/media-upload-plugin
const REMOTE_UPLOAD_PLUGIN_ID = 'b5a2d6b3-c5f4-4f88-aed4-5f3e9877d0a6';
// The plugin's own client uploads 28MB chunks; keep the same size so a reverse
// proxy sized for it (30MB body) also works here.
const UPLOAD_CHUNK_SIZE = 28 * 1024 * 1024;
// Marks tracks that came in through the YouTube flow so they can be filtered
// by tag in Jellyfin. Written after the scan indexes the uploaded file.
const DEFAULT_TAG = 'YouTube';
const TAG_TIMEOUT_MS = 60_000;
const TAG_POLL_MS = 2_000;
// UpdateItem needs ProviderIds present, the server throws on a null map. Ask for
// every editable field so posting the item back keeps the metadata it already has.
const ITEM_FIELDS = [
  'Path',
  'Tags',
  'Genres',
  'Overview',
  'ProviderIds',
  'Studios',
  'Taglines',
  'People',
  'ProductionYear',
  'PremiereDate',
  'EndDate',
  'OfficialRating',
  'CustomRating',
  'ForcedSortName',
  'OriginalTitle',
  'IndexNumber',
  'ParentIndexNumber',
  'CriticRating',
  'CommunityRating',
].join(',');

function apiUrl(cfg: Config, path: string): string {
  return `${cfg.jellyfinUrl.replace(/\/+$/, '')}${path}`;
}

function authHeaders(cfg: Config): Record<string, string> {
  return { 'X-Emby-Token': cfg.jellyfinApiKey };
}

function requireApiKey(cfg: Config): void {
  if (!cfg.jellyfinApiKey) {
    throw new Error(
      'Jellyfin API key is empty: set YTJ_JELLYFIN_API_KEY or add jellyfinApiKey to the config file',
    );
  }
}

// The plugin always writes into one configured server directory, so point it at
// the music library before uploading (first run and after a dir change).
async function ensureUploadDir(cfg: Config): Promise<void> {
  if (cfg.jellyfinUploadDir.trim().length === 0) {
    throw new Error(
      'Jellyfin upload dir is empty: set YTJ_JELLYFIN_UPLOAD_DIR or add jellyfinUploadDir to the config file',
    );
  }

  const url = apiUrl(cfg, `/Plugins/${REMOTE_UPLOAD_PLUGIN_ID}/Configuration`);
  const current = await fetch(url, { headers: authHeaders(cfg) });

  if (!current.ok) {
    throw new Error(
      `RemoteUpload plugin config read failed (${current.status}): is the plugin installed?`,
    );
  }

  const configuration = (await current.json()) as {
    uploaddir?: string;
    uploaddirs?: string[];
  };

  if (configuration.uploaddir === cfg.jellyfinUploadDir) return;

  const dirs = Array.isArray(configuration.uploaddirs) ? configuration.uploaddirs : [];
  if (!dirs.includes(cfg.jellyfinUploadDir)) dirs.push(cfg.jellyfinUploadDir);

  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...configuration,
      uploaddir: cfg.jellyfinUploadDir,
      uploaddirs: dirs,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`RemoteUpload dir update failed (${response.status}): ${body}`);
  }
}

export async function uploadToServer(cfg: Config, file: string): Promise<void> {
  requireApiKey(cfg);
  await ensureUploadDir(cfg);

  const name = basename(file);
  const data = await readFile(file);
  const totalChunks = Math.max(1, Math.ceil(data.byteLength / UPLOAD_CHUNK_SIZE));

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const start = chunkIndex * UPLOAD_CHUNK_SIZE;
    const chunk = data.subarray(start, start + UPLOAD_CHUNK_SIZE);

    const form = new FormData();
    form.append('file', new Blob([chunk], { type: 'audio/mpeg' }), name);
    form.append('chunkIndex', String(chunkIndex));
    form.append('totalChunks', String(totalChunks));

    const response = await fetch(apiUrl(cfg, '/mediaupload/upload'), {
      method: 'POST',
      headers: authHeaders(cfg),
      body: form,
    });

    if (!response.ok) {
      const body = (await response.text()).trim();
      throw new Error(
        `upload failed (${response.status}): ${body || 'no body'} ` +
          `(check that jellyfinUploadDir exists and is writable by the server)`,
      );
    }
  }
}

export async function refreshLibrary(cfg: Config): Promise<void> {
  requireApiKey(cfg);

  const url = apiUrl(cfg, '/Library/Refresh');
  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(cfg),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`jellyfin refresh failed (${response.status}): ${body}`);
  }
}

type ItemDto = {
  Id: string;
  Path?: string;
  Tags?: string[];
  ProviderIds?: Record<string, string>;
};

export type UploadTrack = {
  file: string;
  title: string;
  // picked in the review box, absent means no artwork at all
  art?: ArtCandidate | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Uploads land on the server as <uploadDir>/<file name>; match on that instead of
// the title, which the user may have edited in the review box. The title is only
// used for the search: the file name has the artist prefixed and search is a
// substring match on the item name.
async function findUploadedItem(
  cfg: Config,
  file: string,
  title: string,
): Promise<ItemDto | null> {
  const name = basename(file);
  const params = new URLSearchParams({
    Recursive: 'true',
    IncludeItemTypes: 'Audio',
    SearchTerm: title.trim() || name.replace(/\.mp3$/i, ''),
    Fields: ITEM_FIELDS,
    Limit: '20',
  });

  const response = await fetch(apiUrl(cfg, `/Items?${params}`), { headers: authHeaders(cfg) });
  if (!response.ok) {
    throw new Error(`jellyfin item lookup failed (${response.status})`);
  }

  const body = (await response.json()) as { Items?: ItemDto[] };
  return (body.Items ?? []).find((item) => basename(item.Path ?? '') === name) ?? null;
}

async function addDefaultTag(cfg: Config, item: ItemDto): Promise<boolean> {
  const tags = Array.isArray(item.Tags) ? item.Tags : [];
  if (tags.includes(DEFAULT_TAG)) return false;

  const body: ItemDto = {
    ...item,
    Tags: [...tags, DEFAULT_TAG],
    ProviderIds: item.ProviderIds ?? {},
  };

  const response = await fetch(apiUrl(cfg, `/Items/${item.Id}`), {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(`jellyfin tag update failed (${response.status}): ${message || 'no body'}`);
  }

  return true;
}

// Jellyfin decodes the request body from base64 for SetItemImage.
async function uploadPrimaryImage(
  cfg: Config,
  itemId: string,
  bytes: Buffer,
  mime: string,
): Promise<boolean> {
  const response = await fetch(apiUrl(cfg, `/Items/${itemId}/Images/Primary`), {
    method: 'POST',
    headers: { ...authHeaders(cfg), 'Content-Type': mime },
    body: bytes.toString('base64'),
  });

  return response.ok;
}

async function deletePrimaryImage(cfg: Config, itemId: string): Promise<void> {
  await fetch(apiUrl(cfg, `/Items/${itemId}/Images/Primary`), {
    method: 'DELETE',
    headers: authHeaders(cfg),
  });
}

// The scan runs in the background, so the item can take a while to show up.
export async function finishUploads(
  cfg: Config,
  tracks: UploadTrack[],
): Promise<{ tagged: number; art: number; missed: number }> {
  requireApiKey(cfg);

  const pending = [...tracks];
  const deadline = Date.now() + TAG_TIMEOUT_MS;
  let tagged = 0;
  let art = 0;

  while (pending.length > 0 && Date.now() < deadline) {
    for (let index = pending.length - 1; index >= 0; index--) {
      const track = pending[index];
      const item = await findUploadedItem(cfg, track.file, track.title);
      if (!item) continue;

      if (await addDefaultTag(cfg, item)) tagged += 1;

      if (track.art?.source === 'coverart') {
        if (await uploadPrimaryImage(cfg, item.Id, track.art.bytes, track.art.mime)) art += 1;
      } else if (!track.art) {
        // no pick means no picture; the scan may still have pulled the mp3 thumbnail
        await deletePrimaryImage(cfg, item.Id);
      }

      pending.splice(index, 1);
    }

    if (pending.length === 0) break;
    await sleep(TAG_POLL_MS);
  }

  return { tagged, art, missed: pending.length };
}
