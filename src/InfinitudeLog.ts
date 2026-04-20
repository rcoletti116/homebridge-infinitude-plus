import { Logger } from 'homebridge';

/**
 * Thin wrapper around the Homebridge logger that adds optional
 * verbose-level output without a separate dependency.
 */
export class InfinitudeLog {
  private readonly verboseLogging: boolean;

  constructor(
    private readonly logger: Logger,
    verbose = false,
  ) {
    this.verboseLogging = verbose;
  }

  verbose(message: string): void {
    if (this.verboseLogging) {
      this.logger.info(`[VERBOSE] ${message}`);
    }
  }

  info(message: string): void {
    this.logger.info(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  error(message: string): void {
    this.logger.error(message);
  }

  debug(message: string): void {
    this.logger.debug(message);
  }
}
