/**
 * The badge is the entire discovery surface: `sidePanel.open()` needs a
 * user gesture, so nothing can auto-open, and a number on the toolbar icon is all the
 * signal there is that a page has been discussed.
 *
 * Absent-versus-none matters here. A page with no discussion and a page we could not
 * check must not look identical, or a broken lookup reads as "HN has never mentioned
 * this" — the one failure this design makes hard to notice.
 */

import type { Finding } from '../lib/protocol.ts';

const HN_ORANGE = '#ff6600';
const MUTED = '#9aa0a6';

const formatCount = (count: number): string => {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`;
};

export const applyBadge = async (tabId: number, finding: Finding | null): Promise<void> => {
  const { text, color, title } = describe(finding);
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    // The tab can close between the lookup finishing and the badge being set.
  }
};

const describe = (finding: Finding | null): { text: string; color: string; title: string } => {
  if (finding === null || finding.source === 'unhashable') {
    return { text: '', color: MUTED, title: 'HN Sidecar' };
  }
  switch (finding.source) {
    case 'none':
      return { text: '', color: MUTED, title: 'HN Sidecar: no discussion found' };
    case 'on-hn':
      return { text: '', color: MUTED, title: 'HN Sidecar: you are on Hacker News' };
    case 'error':
      return { text: '?', color: MUTED, title: `HN Sidecar: lookup failed (${finding.detail ?? 'unknown'})` };
    case 'version-skew':
      return { text: '!', color: MUTED, title: `HN Sidecar: ${finding.detail ?? 'index version mismatch'}` };
    case 'hn-dom':
    case 'index': {
      const count = finding.submissions.length;
      const times = count === 1 ? 'once' : `${count} times`;
      return {
        text: formatCount(finding.totalComments),
        color: HN_ORANGE,
        title: `HN Sidecar: discussed ${times}, ${finding.totalComments} comments`,
      };
    }
    default:
      return { text: '', color: MUTED, title: 'HN Sidecar' };
  }
};
