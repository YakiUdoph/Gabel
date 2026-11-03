export type BufferAsset = {
  id: string | null;
  type: 'image' | 'video' | 'document' | string;
  mimeType: string;
  source: string;
  thumbnail: string;
  image?: { altText: string; animatedThumbnail: string | null; userTags: Array<{ handle: string; x: number; y: number }> | null };
  video?: { thumbnailOffset: number | null; title: string | null };
  document?: { title: string | null; thumbnails: string[] };
};

export type BufferPost = {
  id: string;
  channelId: string;
  status: string;
  dueAt: string | null;
  shareMode: string;
  schedulingType: string | null;
  text: string;
  updatedAt: string;
  allowedActions: string[];
  metadata: { type: string } | null;
  tags: Array<{ id: string; name: string }>;
  assets: BufferAsset[];
};

export type AssetInput =
  | { image: { url: string; thumbnailUrl?: string; metadata: { altText: string; animatedThumbnail?: string; userTags?: Array<{ handle: string; x: number; y: number }> } } }
  | { video: { url: string; metadata?: { thumbnailOffset?: number; title?: string } } }
  | { document: { url: string; thumbnailUrl: string; title: string } };

export type GraphQlError = { message: string; extensions?: { code?: string; [key: string]: unknown } };
export type GraphQlEnvelope<T> = { data?: T | null; errors?: GraphQlError[] };
export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
};

export type DbConnection = {
  id: string;
  tenant_id: string;
  buffer_account_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_expires_at: string;
  scopes: string;
  token_version: number;
  status: 'active' | 'reauthorization_required';
};
