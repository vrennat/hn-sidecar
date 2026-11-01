/**
 * Rebuilds a comment body into the live document from an allowlist.
 *
 * The rule this enforces: **never `innerHTML` a string that came off the network.**
 * The input is an inert element from a `DOMParser` document, and every node that ends
 * up in the live tree is one we created ourselves. Nothing is copied wholesale; not
 * markup, not attributes.
 *
 * The allowlist was derived from a real 2,376-comment thread rather than guessed. The
 * only tags HN emits inside `.commtext` are `p`, `a`, `i`, `pre`, `code`, and the only
 * attributes are `href` and `rel`.
 */

const ALLOWED_TAGS = new Set(['P', 'A', 'I', 'PRE', 'CODE']);

/**
 * Elements to drop whole, children included, rather than unwrap.
 *
 * The default policy below is to unwrap an unrecognised element so its text survives —
 * if HN adds a `<span>`, a comment should lose the wrapper, not go blank. But for these
 * the child text is not human-readable content: unwrapping a `<script>` renders its
 * source as visible prose, and a `<style>` dumps CSS into the comment. Not executable,
 * since we build every node ourselves, but wrong, and the wrongness would be invisible
 * until someone read a comment full of code.
 */
const DROPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'MATH',
  'HEAD',
  'TITLE',
]);

const safeHref = (href: string): string | null => {
  try {
    if (!href.trim()) return null;
    const url = new URL(href, 'https://news.ycombinator.com/');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

const rebuild = (source: Node, target: Node, doc: Document): void => {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const element = child as Element;
    if (DROPPED_TAGS.has(element.tagName)) continue;
    if (!ALLOWED_TAGS.has(element.tagName)) {
      // Unwrap rather than drop: an unexpected wrapper should cost us the wrapper,
      // not the text inside it. HN adding a `<span>` must not blank the comment.
      rebuild(element, target, doc);
      continue;
    }

    const created = doc.createElement(element.tagName.toLowerCase());
    if (element.tagName === 'A') {
      const href = safeHref(element.getAttribute('href') ?? '');
      if (href !== null) {
        const anchor = created as HTMLAnchorElement;
        anchor.href = href;
        anchor.target = '_blank';
        // Forced, not copied — the source's own rel is not trusted to contain these.
        anchor.rel = 'noopener noreferrer nofollow';
      }
    }
    rebuild(element, created, doc);
    target.appendChild(created);
  }
};

/**
 * Sanitizes `source` into a fragment belonging to `doc`.
 *
 * Called per row as rows enter the viewport, never for all 2,400 up front — that
 * laziness is why a huge thread opens instantly.
 */
export const sanitizeBody = (source: Element, doc: Document): DocumentFragment => {
  const fragment = doc.createDocumentFragment();
  rebuild(source, fragment, doc);
  return fragment;
};
