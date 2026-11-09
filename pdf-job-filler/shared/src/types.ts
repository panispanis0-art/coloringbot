/** One piece of text as pdf.js reports it. Coordinates are PDF points, origin bottom-left. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A run of items on one line that sit close together (a "cell" in table-like layouts). */
export interface LineSegment {
  text: string;
  x: number;
  w: number;
  items: TextItem[];
}

export interface TextLine {
  /** 1-based page number */
  page: number;
  /** index of the line within the whole document (reading order) */
  index: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  segments: LineSegment[];
}

export interface SourcePage {
  page: number;
  width: number;
  height: number;
  items: TextItem[];
  lines: TextLine[];
}

export interface SourceDoc {
  pages: SourcePage[];
  /** all lines of all pages, in reading order */
  lines: TextLine[];
  /** lines joined with "\n", pages separated by "\n\f\n" */
  fullText: string;
}

export type FieldType =
  "text" | "checkbox" | "dropdown" | "optionlist" | "radio" | "button" | "signature" | "unknown";

export interface FormFieldInfo {
  name: string;
  type: FieldType;
  /** choices for dropdown / option list / radio */
  options?: string[] | undefined;
  /** current value in the blank form */
  currentValue?: string | undefined;
  /** first widget location: 1-based page and rectangle in points */
  page?: number | undefined;
  rect?: { x: number; y: number; w: number; h: number } | undefined;
  readOnly?: boolean | undefined;
  multiline?: boolean | undefined;
  maxLength?: number | undefined;
}

export type Transform = "none" | "upper" | "lower" | "title";

interface RuleBase {
  transform?: Transform | undefined;
  /** used when the rule finds nothing */
  defaultValue?: string | undefined;
  prefix?: string | undefined;
  suffix?: string | undefined;
}

/** Find a label in the text and take the value next to / below it. */
export interface LabelRule extends RuleBase {
  type: "label";
  label: string;
  /**
   * auto: rest of the same cell/line, else the next cell, else the next line.
   * sameLine: text after the label on the same line.
   * nextLine: the next line in reading order.
   * below: the line underneath the label (overlapping horizontally).
   */
  valueOn?: "auto" | "sameLine" | "nextLine" | "below" | undefined;
  /** 1-based: use the n-th time the label appears. Default 1. */
  occurrence?: number | undefined;
  caseSensitive?: boolean | undefined;
  /** Optional regex: cut the value where this matches (e.g. "\\s{2,}|Date:"). */
  stopAt?: string | undefined;
  /** How many lines to take for nextLine/below. Default 1. */
  lines?: number | undefined;
}

/** Run a regular expression over the full text. */
export interface RegexRule extends RuleBase {
  type: "regex";
  pattern: string;
  /** JS regex flags, default "i". "g" is ignored. */
  flags?: string | undefined;
  /** capture group to use. Default 1 if the pattern has groups, else 0. */
  group?: number | undefined;
  /** 1-based match number. Default 1. */
  occurrence?: number | undefined;
}

/** Take all text inside a rectangle on a page. */
export interface PositionRule extends RuleBase {
  type: "position";
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StaticRule extends RuleBase {
  type: "static";
  value: string;
}

export interface JobNameRule extends RuleBase {
  type: "jobName";
}

/** Today's date. Tokens: DD, MM, YYYY, YY */
export interface DateRule extends RuleBase {
  type: "date";
  format?: string | undefined;
}

export interface SkipRule {
  type: "skip";
}

export type MappingRule =
  LabelRule | RegexRule | PositionRule | StaticRule | JobNameRule | DateRule | SkipRule;

export interface FieldMapping {
  fieldName: string;
  fieldType: FieldType;
  rule: MappingRule;
}

export interface Template {
  /** schema version */
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** file name of the target form, for display */
  targetFormName?: string | undefined;
  /** the blank target form, base64. Makes the template self-contained (web + bot). */
  targetFormBase64?: string | undefined;
  mappings: FieldMapping[];
  options: {
    flatten: boolean;
    /** Telegram bot: name jobs automatically, e.g. "{ClientName} - {OrderNumber}" */
    jobNamePattern?: string | undefined;
  };
}

export interface PdfMetadata {
  author?: string | undefined;
  creator?: string | undefined;
  producer?: string | undefined;
  /** If set, written as the document Title. */
  title?: string | undefined;
  subject?: string | undefined;
  keywords?: string | undefined;
}

export interface FillOptions {
  flatten?: boolean | undefined;
  metadata?: PdfMetadata | undefined;
  /** Remove the XMP metadata stream so viewers show the Info values above. Default true. */
  stripXmp?: boolean | undefined;
  /** Set ModDate (and CreationDate if missing) to now. Default true. */
  updateDates?: boolean | undefined;
  /** A TTF/OTF font for characters the standard Helvetica cannot draw (ă, ș, ț, Cyrillic...). */
  fontBytes?: Uint8Array | undefined;
}

export interface FillResult {
  bytes: Uint8Array;
  /** fields that were written */
  filled: string[];
  /** fields that are in the values but not in the form, or failed */
  warnings: string[];
}
