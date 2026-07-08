export interface OAuthUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  provider: 'google';
  providerId: string;
  roles: string[];
}

export interface GoogleUpsertInput {
  id: string;
  displayName: string;
  email?: string;
  picture?: string | null;
}
