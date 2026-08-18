import { AppError } from '@/lib/errors';

/**
 * The write would have left the system with no administrator.
 *
 * 409 rather than 422: the request is well-formed and would have been accepted
 * a moment ago and may be accepted a moment from now — what is wrong is the
 * state it would produce, given the rest of the table. That is the definition
 * of a conflict, and it is also the answer a client can act on, since promoting
 * somebody else makes the same request succeed. A 422 would say "this body is
 * unacceptable", which is false.
 *
 * Deliberately not 403. The caller is authorised to edit this user; the system
 * is refusing on its own behalf, and conflating the two sends an administrator
 * looking for a permission they already have.
 */
export class LastAdminError extends AppError {
  constructor() {
    super(
      409,
      'This is the last account with the admin role; promote another before removing it',
      'LAST_ADMIN',
    );
    this.name = 'LastAdminError';
  }
}
