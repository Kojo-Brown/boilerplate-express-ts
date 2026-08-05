import { Router } from 'express';
import { usersController } from '@/users/users.controller';
import {
  createUserBodySchema,
  updateUserBodySchema,
  userIdParamsSchema,
} from '@/users/users.schemas';
import { validate } from '@/middleware/validate.middleware';
import { requireAuth, requireRole } from '@/middleware/auth.middleware';

const router: Router = Router();

// Auth stays ahead of validation so an unauthenticated caller gets 401/403
// without learning anything about the accepted request shape.
router.get('/', requireAuth, requireRole('admin'), usersController.list);
router.get(
  '/:id',
  requireAuth,
  validate({ params: userIdParamsSchema }),
  usersController.getById,
);
router.post(
  '/',
  requireAuth,
  requireRole('admin'),
  validate({ body: createUserBodySchema }),
  usersController.create,
);
router.put(
  '/:id',
  requireAuth,
  validate({ params: userIdParamsSchema, body: updateUserBodySchema }),
  usersController.update,
);
router.delete(
  '/:id',
  requireAuth,
  requireRole('admin'),
  validate({ params: userIdParamsSchema }),
  usersController.remove,
);

export { router as usersRouter };
