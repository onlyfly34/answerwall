/**
 * Keeps a container in step with a growing Markdown text without re-creating
 * what did not change: the text is split into top-level blocks, and only the
 * blocks whose source differs from the previous render are parsed, sanitised
 * and replaced. While an answer streams that is the last block, so the cost
 * of an update does not grow with the length of the answer.
 */
import { CODE_LANGUAGE_CLASS, lexMarkdown, renderBlock } from './render.ts';

export interface CodeBlockLabels {
  copy: string;
}

interface RenderedBlock {
  raw: string;
  nodes: ChildNode[];
}

export interface IncrementalMarkdown {
  /** Brings the container up to date; returns how many blocks were rendered anew. */
  update(text: string): number;
  /** Drops every rendered block, so the next update renders all of them. */
  reset(): void;
}

export const COPY_CODE_ATTRIBUTE = 'data-copy-code';

/** Wraps a `<pre>` with a header holding its language and a copy button. */
function decorateCodeBlocks(fragment: DocumentFragment, labels: CodeBlockLabels): void {
  for (const pre of Array.from(fragment.querySelectorAll('pre'))) {
    const language = CODE_LANGUAGE_CLASS.exec(pre.querySelector('code')?.className ?? '')?.[1];
    const wrapper = document.createElement('div');
    wrapper.className = 'wall-code';
    const header = document.createElement('div');
    header.className = 'wall-code-header';
    const name = document.createElement('span');
    name.textContent = language ?? '';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wall-button wall-button-small';
    button.setAttribute(COPY_CODE_ATTRIBUTE, '');
    button.textContent = labels.copy;
    header.append(name, button);
    pre.replaceWith(wrapper);
    wrapper.append(header, pre);
  }
}

export function createIncrementalMarkdown(
  container: HTMLElement,
  labels: () => CodeBlockLabels,
): IncrementalMarkdown {
  const rendered: RenderedBlock[] = [];
  let definitions = '';

  function removeFrom(index: number): void {
    for (const block of rendered.splice(index)) {
      for (const node of block.nodes) node.remove();
    }
  }

  return {
    update(text) {
      const parsed = lexMarkdown(text);
      if (parsed.definitions !== definitions) {
        definitions = parsed.definitions;
        removeFrom(0);
      }
      let unchanged = 0;
      while (
        unchanged < rendered.length &&
        unchanged < parsed.blocks.length &&
        rendered[unchanged]?.raw === parsed.blocks[unchanged]?.raw
      ) {
        unchanged += 1;
      }
      removeFrom(unchanged);
      const fresh = parsed.blocks.slice(unchanged);
      for (const block of fresh) {
        const fragment = renderBlock(block);
        decorateCodeBlocks(fragment, labels());
        const nodes = Array.from(fragment.childNodes);
        container.append(fragment);
        rendered.push({ raw: block.raw, nodes });
      }
      return fresh.length;
    },
    reset() {
      removeFrom(0);
      definitions = '';
    },
  };
}
