import express from 'express';
import multer from 'multer';
import auth from '../middleware/auth.js';
import { createSummary, getSummaries, deleteSummary } from '../controllers/summaryController.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/', auth, upload.single('audio'), createSummary);
router.get('/', auth, getSummaries);
router.delete('/:id', auth, deleteSummary);

export default router;
