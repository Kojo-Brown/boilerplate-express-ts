export interface JwtPayload {
  userId: string;
  roles: string[];
  type: 'access' | 'refresh';
  /** Unique per token. Two tokens minted in the same second are still distinct. */
  jti?: string;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: {
    id: string;
    email: string;
    roles: string[];
  };
  accessToken: string;
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}
