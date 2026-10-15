// Export all public APIs from the imessage package
export {
  convertAppleTimestamp,
  decodeAttributedBody,
  getChats,
  getHandles,
  getImessageDbPath,
  getMessagesFromChat,
  getRecentMessages,
  openMessagesDatabase,
  readEnv,
  searchMessages,
} from "./src/messages.ts";

export {
  type AttachmentFile,
  type AttachmentFileStatus,
  expandAttachmentPath,
  getAttachmentById,
  getAttachmentSummaries,
  getMessageAttachments,
  resolveAttachmentFile,
  toAttachmentSummary,
} from "./src/attachments.ts";

export {
  findContactsDatabasePaths,
  getContactsSourcesPath,
  openContactsDatabases,
  searchContactsByName,
} from "./src/contacts.ts";

export type {
  Attachment,
  AttachmentSummary,
  Chat,
  ContactInfo,
  Handle,
  Message,
  MessageWithHandle,
  PaginatedResult,
  SearchOptions,
} from "./src/types.ts";
