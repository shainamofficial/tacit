// @tacit/connector-slack — Slack read-only connector: channel-scoped history
// backfill, per-channel cursors, membership-as-ACL (F-ING-1..4, F-ING-6).
export type { SlackApi, SlackConversation, SlackMessage, SlackUser } from './api';
export { CHANNEL_PREFIX, MSG_PREFIX, conversationInScope, cursorKey, indexUsers, renderThread, syncSlack, type SlackSyncOptions, type UserIndex } from './connector';
export { SLACK_BOT_SCOPES, SlackWebApi } from './web';
