// The slice of Slack the connector needs. Implemented by the @slack/web-api
// adapter (web.ts) and by an export-backed fake for tests.

export interface SlackConversation {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  readonly isArchived: boolean;
  readonly isIm: boolean;
  readonly isMpim: boolean;
  readonly topic: string;
  readonly purpose: string;
}

export interface SlackUser {
  readonly id: string;
  readonly name: string;
  readonly realName: string;
  readonly email: string | null;
  readonly isBot: boolean;
  readonly deleted: boolean;
}

export interface SlackMessage {
  readonly ts: string;
  readonly user: string | null;
  readonly text: string;
  readonly subtype?: string;
  readonly threadTs?: string;
  readonly replyCount?: number;
}

export interface SlackApi {
  listConversations(): Promise<SlackConversation[]>;
  listMembers(conversationId: string): Promise<string[]>;
  listUsers(): Promise<SlackUser[]>;
  /** Top-level messages newer than `oldest` (exclusive), ascending by ts. */
  history(conversationId: string, opts: { oldest?: string }): Promise<SlackMessage[]>;
  /** A thread's messages including the root, ascending. */
  replies(conversationId: string, threadTs: string): Promise<SlackMessage[]>;
}
