// Teach mode: the user taps the right value in the source text and the bot works out a rule for it.
import { applyRule, type MappingRule, type SourceDoc, type TextLine, type LineSegment } from '../../shared/src/index.ts';

export interface PickedSegment {
  line: TextLine;
  seg: LineSegment;
  segIndex: number;
}

/** Every text piece of the PDF, in reading order (what the user can tap). */
export function allSegments(source: SourceDoc): PickedSegment[] {
  return source.lines.flatMap((line) => line.segments.map((seg, segIndex) => ({ line, seg, segIndex })));
}

const clean = (s: string) => s.replace(/[\s:：\-–—#=.|]+$/, '').trim();
const looksLikeLabel = (s: string) => s.length >= 2 && s.length <= 40 && /\p{L}/u.test(s);

/**
 * Find a rule that reads exactly this piece of text, preferring rules that also work on other PDFs:
 * 1. "Label: value" in the same piece, 2. a label piece to its left, 3. a label right above it,
 * 4. otherwise the area on the page.
 */
export function learnRule(source: SourceDoc, picked: PickedSegment): { rule: MappingRule; how: string } {
  const { line, seg, segIndex } = picked;
  const want = seg.text.trim();
  const works = (rule: MappingRule, value = want) => applyRule(source, rule) === value;

  const colon = seg.text.search(/[:：]/);
  if (colon > 0 && seg.text.slice(colon + 1).trim()) {
    const label = clean(seg.text.slice(0, colon));
    const value = seg.text.slice(colon + 1).trim();
    const rule: MappingRule = { type: 'label', label, valueOn: 'sameLine' };
    if (looksLikeLabel(label) && works(rule, value)) return { rule, how: `the text after "${label}"` };
  }

  const left = line.segments[segIndex - 1];
  if (left) {
    const label = clean(left.text);
    const rule: MappingRule = { type: 'label', label, valueOn: 'auto' };
    if (looksLikeLabel(label) && works(rule)) return { rule, how: `the text next to "${label}"` };
  }

  const above = source.lines
    .filter((l) => l.page === line.page && l.y > line.y && l.y - line.y < line.h * 3)
    .sort((a, b) => a.y - b.y)[0];
  const head = above?.segments.find((s) => s.x < seg.x + seg.w && s.x + s.w > seg.x - 5);
  if (head) {
    const label = clean(head.text);
    const rule: MappingRule = { type: 'label', label, valueOn: 'below' };
    if (looksLikeLabel(label) && works(rule)) return { rule, how: `the text under "${label}"` };
  }

  const pad = 3;
  return {
    rule: { type: 'position', page: line.page, x: seg.x - pad, y: line.y - line.h * 0.3 - pad, w: seg.w + pad * 2, h: line.h * 1.3 + pad * 2 },
    how: 'that spot on the page',
  };
}
