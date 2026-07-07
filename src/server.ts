import { createApp } from '@/app';
import { env } from '@/config/env';

const app = createApp();

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}/v1`);
});
