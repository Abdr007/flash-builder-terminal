/**
 * Terminal Renderer — copied verbatim from bolt-terminal/src/cli/renderer.ts.
 *
 * Uses the alternate screen buffer (like vim/top/htop). Overwrites lines in
 * place — never writes more lines than the terminal height, preventing
 * scroll-induced corruption.
 */

export class TermRenderer {
  private previousFrame: string[] = [];
  private rendering = false;
  private inAltScreen = false;

  /** Enter alternate screen buffer */
  enterAltScreen(): void {
    if (!this.inAltScreen) {
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
      this.inAltScreen = true;
    }
  }

  /** Leave alternate screen buffer */
  leaveAltScreen(): void {
    if (this.inAltScreen) {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      this.inAltScreen = false;
    }
  }

  /** Clear the screen and reset frame state. */
  clear(): void {
    process.stdout.write('\x1b[2J\x1b[H');
    this.previousFrame = [];
  }

  /**
   * Render a frame — overwrites lines in place, caps at terminal height.
   * Uses cursor home + line-by-line overwrite + clear-to-end-of-line.
   * Never writes more than terminal rows, so no scrolling occurs.
   */
  render(lines: string[]): void {
    if (this.rendering) return;
    this.rendering = true;

    try {
      const maxRows = (process.stdout.rows || 24) - 1; // leave 1 row margin
      const visibleLines = lines.slice(0, maxRows);

      let buf = '\x1b[?25l\x1b[H'; // hide cursor + cursor home
      for (let i = 0; i < visibleLines.length; i++) {
        buf += visibleLines[i] + '\x1b[K\n';
      }
      buf += '\x1b[J'; // clear from cursor to end of screen
      buf += '\x1b[?25h'; // show cursor

      process.stdout.write(buf);
      this.previousFrame = [...visibleLines];
    } finally {
      this.rendering = false;
    }
  }

  /** Check if a new frame differs from the current frame. */
  hasChanged(lines: string[]): boolean {
    const maxRows = (process.stdout.rows || 24) - 1;
    const visibleLines = lines.slice(0, maxRows);
    if (visibleLines.length !== this.previousFrame.length) return true;
    for (let i = 0; i < visibleLines.length; i++) {
      if (visibleLines[i] !== this.previousFrame[i]) return true;
    }
    return false;
  }

  /** Reset renderer state without clearing screen */
  reset(): void {
    this.previousFrame = [];
    this.rendering = false;
  }
}
