import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Config } from './config.js';

// RemoteUpload plugin: https://github.com/grandguyjs/media-upload-plugin
const REMOTE_UPLOAD_PLUGIN_ID = 'b5a2d6b3-c5f4-4f88-aed4-5f3e9877d0a6';
// The plugin's own client uploads 28MB chunks; keep the same size so a reverse
// proxy sized for it (30MB body) also works here.
const UPLOAD_CHUNK_SIZE = 28 * 1024 * 1024;

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
      const body = await response.text();
      throw new Error(`upload failed (${response.status}): ${body}`);
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
