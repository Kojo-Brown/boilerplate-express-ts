process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-must-be-at-least-32-chars!!';
process.env['JWT_REFRESH_SECRET'] = 'test-refresh-secret-must-be-at-least-32-chars!';
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '4000';
process.env['DATABASE_URL'] = 'postgresql://user:password@localhost:5432/testdb';
process.env['AWS_REGION'] = 'us-east-1';
process.env['AWS_ACCESS_KEY_ID'] = 'test-key-id';
process.env['AWS_SECRET_ACCESS_KEY'] = 'test-secret-key';
process.env['S3_BUCKET'] = 'test-bucket';
process.env['S3_PRESIGNED_EXPIRES_IN'] = '3600';
// Far below the 15s default, so `events.e2e.test.ts` can observe a real
// heartbeat on a real socket rather than asserting that a timer was scheduled.
// The mechanism is identical at either interval; only the wait is not.
process.env['SSE_HEARTBEAT_INTERVAL_MS'] = '150';
// Small enough that the same suite can drive a cursor off the end of the buffer
// and see the `reset` a client's re-sync path exists for.
process.env['SSE_REPLAY_BUFFER_SIZE'] = '8';
