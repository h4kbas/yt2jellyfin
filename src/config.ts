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
  jellyfinUploadDir: '/data/music/YouTube',
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

export type LoadedConfig = {
  config: Config;
  path: string;
  // no config file yet (or unreadable one): the TUI has to ask for the values
  needsSetup: boolean;
};

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  mkdirSync(config.downloadDir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  chmodSync(CONFIG_PATH, 0o600);
}

export function loadConfig(): LoadedConfig {
  let needsSetup = false;
  let stored: Partial<Config> = {};

  if (!existsSync(CONFIG_PATH)) {
    needsSetup = true;
  } else {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
    } catch {
      // broken/empty config: ask again with defaults instead of crashing
      stored = {};
      needsSetup = true;
    }
  }

  const config: Config = { ...DEFAULT_CONFIG, ...stored };

  for (const [envKey, configKey] of Object.entries(ENV_OVERRIDES)) {
    const value = process.env[envKey];
    if (typeof value === 'string' && value.length > 0) {
      config[configKey] = value;
    }
  }

  return { config, path: CONFIG_PATH, needsSetup };
}
