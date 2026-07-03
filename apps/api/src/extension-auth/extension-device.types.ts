import type { WorkspaceRole } from '@prisma/client';

export interface PairExtensionInput {
  pairingCode: string;
  publicKeyJwk: unknown;
  deviceLabel?: string;
  displayName?: string;
  redditUsername?: string;
}

export interface CreatePairingCodeInput {
  displayName?: string;
  role?: WorkspaceRole | string;
  expiresInMinutes?: number;
}

export interface VerifyExtensionInput {
  deviceId: string;
  challengeId: string;
  nonce: string;
  proof: string;
}

export interface RedditSessionCookieInput {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None' | 'no_restriction' | 'lax' | 'strict' | 'unspecified';
}

export interface RedditBrowserMetadataInput {
  engine?: 'chromium' | 'firefox';
  userAgent?: string;
  language?: string;
  platform?: string;
}

export interface SyncRedditSessionInput {
  ticket: string;
  cookies: RedditSessionCookieInput[];
  browser?: RedditBrowserMetadataInput;
}

export interface ExtensionBatchSource {
  sourceId?: string;
  type: string;
  name?: string;
  subreddit?: string;
  url?: string;
  searchQuery?: string;
}

export interface ExtensionBatchPost {
  externalPostId?: string;
  title: string;
  body?: string;
  authorUsername?: string;
  subreddit?: string;
  permalink: string;
  score?: number;
  commentCount?: number;
  postedAt?: string;
}

export interface ExtensionIngestionBatch {
  source: ExtensionBatchSource;
  posts: ExtensionBatchPost[];
  capturedAt?: string;
}

export interface ExtensionBatchInput {
  deviceId: string;
  timestamp: string;
  nonce: string;
  proof: string;
  batch: ExtensionIngestionBatch;
}
