export type SseJsonStreamOptions = {
  /**
   * Kalau true, event `data:` yang bukan JSON akan diabaikan.
   * Berguna untuk endpoint yang kadang mengirim heartbeat/metadata non-JSON.
   */
  ignoreInvalidJson?: boolean;
};

type EventSeparator = {
  index: number;
  length: number;
};

function findEventSeparator(buffer: string): EventSeparator | undefined {
  const separators = ["\r\n\r\n", "\n\n", "\r\r"];
  let found: EventSeparator | undefined;

  for (const separator of separators) {
    const index = buffer.indexOf(separator);
    if (index === -1) continue;

    if (!found || index < found.index) {
      found = { index, length: separator.length };
    }
  }

  return found;
}

function extractSseData(eventBlock: string): string | undefined {
  const dataLines: string[] = [];

  for (const line of eventBlock.split(/\r\n|\n|\r/)) {
    if (!line.startsWith("data:")) continue;

    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  return dataLines.join("\n");
}

function parseSseJsonData<T>(data: string, options: SseJsonStreamOptions): T | undefined {
  const trimmed = data.trim();

  if (!trimmed || trimmed === "[DONE]") {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch (error) {
    if (options.ignoreInvalidJson) {
      return undefined;
    }

    throw new Error(`SSE JSON tidak valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Parser SSE yang toleran terhadap LF/CRLF dan event terakhir tanpa blank-line.
 */
export async function* parseSseJsonStream<T>(
  response: Response,
  options: SseJsonStreamOptions = {},
): AsyncGenerator<T> {
  if (!response.body) {
    throw new Error("Response streaming tidak memiliki body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  const parseEventBlock = function* (eventBlock: string): Generator<T> {
    const data = extractSseData(eventBlock);
    if (data === undefined) return;

    const parsed = parseSseJsonData<T>(data, options);
    if (parsed !== undefined) {
      yield parsed;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        completed = true;
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let separator = findEventSeparator(buffer);

      while (separator) {
        const eventBlock = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);

        yield* parseEventBlock(eventBlock);
        separator = findEventSeparator(buffer);
      }
    }

    if (buffer.trim()) {
      yield* parseEventBlock(buffer);
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }
}
