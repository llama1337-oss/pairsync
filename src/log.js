const STYLE = {
  warn: '33',
  error: '31',
  paused: '1;31',
  resumed: '32',
};

const pad = (n) => String(n).padStart(2, '0');

/**
 * One timestamped line per action; multi-line blocks (PAUSED) continue on indented lines.
 * `--quiet` suppresses routine lines only: warnings, conflicts and errors always print.
 */
export function createLogger({ stream = process.stdout, quiet = false, color = false, clock = () => new Date() } = {}) {
  const paint = (style, text) => (color && style ? `\x1b[${style}m${text}\x1b[0m` : text);

  const write = (style, lines) => {
    const now = clock();
    const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const indent = ' '.repeat(stamp.length + 1);
    const [first, ...rest] = lines;
    stream.write(`${stamp} ${paint(style, first)}\n${rest.map((line) => `${indent}${line}\n`).join('')}`);
  };

  return {
    info(message) {
      if (!quiet) write(null, [message]);
    },
    warn(message) {
      write(STYLE.warn, [`WARN ${message}`]);
    },
    error(message) {
      write(STYLE.error, [`ERROR ${message}`]);
    },
    paused(lines) {
      write(STYLE.paused, lines);
    },
    resumed(message) {
      write(STYLE.resumed, [`RESUMED: ${message}`]);
    },
  };
}
