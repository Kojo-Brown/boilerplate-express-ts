export interface JwtPayload {
  userId: string;
  roles: string[];
  type: 'access' | 'refresh';
  /**
   * Unique token id. `iat` only has second resolution, so without a random
   * claim two tokens minted for the same user within the same second are
   * byte-identical — which silently defeats refresh-token rotation and the
   * reuse detection built on top of it.
   */
  jti: string;
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
