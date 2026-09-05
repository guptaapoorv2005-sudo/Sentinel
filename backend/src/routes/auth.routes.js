import { Router } from 'express';
import { validate } from '../middlewares/validate.middleware.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { registerSchema, loginSchema, changePasswordSchema } from '../validators/auth.validators.js';
import { register, login, googleLogin, refresh, me, logout, changePassword } from '../controllers/auth.controller.js';

const router = Router();

router.post('/register', validate(registerSchema), register);
router.post('/login', validate(loginSchema), login);
router.post('/google', googleLogin);
router.post('/refresh', refresh);
router.get('/me', requireAuth, me);
router.patch('/change-password', requireAuth, validate(changePasswordSchema), changePassword);
router.post('/logout', logout);


export default router;
