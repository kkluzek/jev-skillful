export type ReminderKind = "memory" | "rule";

export interface ReminderDocument {
  id: string;
  canonicalKey: string;
  kind: ReminderKind;
  title: string;
  hook: string;
  path: string;
  description: string;
  body: string;
  identifiers: string[];
  citations: string[];
}

export interface RankedReminder {
  document: ReminderDocument;
  score: number;
}

export interface ReminderSelection {
  text: string | null;
  ids: string[];
  degraded: boolean;
  reason?: string;
}

export interface ReminderHookInput {
  hook_event_name?: string;
  source?: string;
  trigger?: string;
  compact_summary?: string;
  transcript_path?: string;
  session_id?: string;
  cwd?: string;
}
