import { Router } from 'express';
import { usersController } from '@/users/users.controller';
import { requireAuth, requireRole } from '@/middleware/auth.middleware';

const router = Router();

router.get('/', requireAuth, requireRole('admin'), usersController.list);
router.get('/:id', requireAuth, usersController.getById);
router.post('/', requireAuth, requireRole('admin'), usersController.create);
router.put('/:id', requireAuth, usersController.update);
router.delete('/:id', requireAuth, requireRole('admin'), usersController.remove);

export { router as usersRouter };
