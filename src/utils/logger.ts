import streamDeck from "@elgato/streamdeck";

/**
 * SDK 로거 래퍼
 * console.log 대신 이것을 사용하면 Stream Deck 로그 파일에 기록됩니다.
 * 로그 경로: ~/Library/Application Support/com.elgato.StreamDeck/Plugins/.../logs/
 */
export const logger = {
  info: (...args: unknown[]) => {
    streamDeck.logger.info(args.map(String).join(" "));
  },
  warn: (...args: unknown[]) => {
    streamDeck.logger.warn(args.map(String).join(" "));
  },
  error: (...args: unknown[]) => {
    streamDeck.logger.error(args.map(String).join(" "));
  },
  debug: (...args: unknown[]) => {
    streamDeck.logger.debug(args.map(String).join(" "));
  },
};
