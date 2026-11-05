import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Config = {
  jellyfinUrl: string;
  jellyfinApiKey: string;
  jellyfinUploadDir: string;
  downloadDir: string;
  ytDlpPath: string;
  ffmpegPath: string;
};

const CONFIG_PATH = join(homedir(), '.config', 'yt2jellyfin', 'config.json');

const DEFAULT_CONFIG: Config = {
  jellyfinUrl: 'http://media.example.com:8096',
  jellyfinApiKey: '',
  jellyfinUploadDir: '/media/music/YouTube',
  downloadDir: join(homedir(), 'Music', 'yt2jellyfin'),
  ytDlpPath: 'yt-dlp',
  ffmpegPath: 'ffmpeg',
};

const ENV_OVERRIDES: Record<string, keyof Config> = {
  YTJ_JELLYFIN_URL: 'jellyfinUrl',
  YTJ_JELLYFIN_API_KEY: 'jellyfinApiKey',
  YTJ_JELLYFIN_UPLOAD_DIR: 'jellyfinUploadDir',
  YTJ_DOWNLOAD_DIR: 'downloadDir',
  YTJ_YTDLP: 'ytDlpPath',
  YTJ_FFMPEG: 'ffmpegPath',
};

export type LoadedConfig = { config: Config; path: string; created: boolean };

export function loadConfig(): LoadedConfig {
  let created = false;

  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
    chmodSync(CONFIG_PATH, 0o600);
    created = true;
  }

  const stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  const config: Config = { ...DEFAULT_CONFIG, ...stored };

  for (const [envKey, configKey] of Object.entries(ENV_OVERRIDES)) {
    const value = process.env[envKey];
    if (typeof value === 'string' && value.length > 0) {
      config[configKey] = value;
    }
  }

  mkdirSync(config.downloadDir, { recursive: true });

  return { config, path: CONFIG_PATH, created };
}
