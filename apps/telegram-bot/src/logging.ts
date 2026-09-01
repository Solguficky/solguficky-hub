export const serviceName = "telegram-bot";

export type LogFields = Record<string, string | number | boolean>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

export function createLogger(level: string): Logger {
  const min = parseLevel(level);
  return {
    debug(message, fields) {
      write("debug", 20, min, message, fields);
    },
    info(message, fields) {
      write("info", 30, min, message, fields);
    },
    warn(message, fields) {
      write("warn", 40, min, message, fields);
    },
    error(message, fields) {
      write("error", 50, min, message, fields);
    },
  };
}

function parseLevel(raw: string): number {
  switch (raw) {
    case "debug":
      return 20;
    case "info":
      return 30;
    case "warn":
      return 40;
    case "error":
      return 50;
    default:
      return 30;
  }
}

function write(
  level: string,
  value: number,
  min: number,
  message: string,
  fields: LogFields | undefined,
): void {
  if (value < min) {
    return;
  }
  const record: LogFields = {
    service: serviceName,
    level,
    msg: message,
    ...fields,
  };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
