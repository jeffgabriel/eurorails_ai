export enum BotLogLevel {
  TRACE = 0,
  DEBUG = 1,
  INFO = 2,
  WARN = 3,
  ERROR = 4,
}

const LOG_LEVEL_LABELS: Record<BotLogLevel, string> = {
  [BotLogLevel.TRACE]: 'TRACE',
  [BotLogLevel.DEBUG]: 'DEBUG',
  [BotLogLevel.INFO]: 'INFO',
  [BotLogLevel.WARN]: 'WARN',
  [BotLogLevel.ERROR]: 'ERROR',
};

let globalLogLevel: BotLogLevel = BotLogLevel.INFO;

export function setGlobalBotLogLevel(level: BotLogLevel): void {
  globalLogLevel = level;
}

export function getGlobalBotLogLevel(): BotLogLevel {
  return globalLogLevel;
}

export class BotLogger {
  private context: string;
  private gameId?: string;
  private botPlayerId?: string;

  constructor(context: string, gameId?: string, botPlayerId?: string) {
    this.context = context;
    this.gameId = gameId;
    this.botPlayerId = botPlayerId;
  }

  trace(message: string, data?: Record<string, unknown>): void {
    this.log(BotLogLevel.TRACE, message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log(BotLogLevel.DEBUG, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log(BotLogLevel.INFO, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log(BotLogLevel.WARN, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log(BotLogLevel.ERROR, message, data);
  }

  withContext(gameId: string, botPlayerId: string): BotLogger {
    return new BotLogger(this.context, gameId, botPlayerId);
  }

  private log(level: BotLogLevel, message: string, data?: Record<string, unknown>): void {
    if (level < globalLogLevel) return;

    const prefix = this.formatPrefix(level);
    const suffix = data ? ` ${JSON.stringify(data)}` : '';
    const fullMessage = `${prefix} ${message}${suffix}`;

    if (level >= BotLogLevel.ERROR) {
      console.error(fullMessage);
    } else if (level >= BotLogLevel.WARN) {
      console.warn(fullMessage);
    } else {
      console.log(fullMessage);
    }
  }

  private formatPrefix(level: BotLogLevel): string {
    const label = LOG_LEVEL_LABELS[level];
    const parts = [`[BOT:${label}]`, `[${this.context}]`];
    if (this.gameId) {
      parts.push(`[game:${this.gameId.slice(0, 8)}]`);
    }
    if (this.botPlayerId) {
      parts.push(`[bot:${this.botPlayerId.slice(0, 8)}]`);
    }
    return parts.join(' ');
  }
}
