import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRetryableRedditNavigationError,
  toOldRedditUrl,
} from '../../src/reddit-public/reddit-navigation';

test('converts modern Reddit URLs to old Reddit fallback URLs', () => {
  assert.equal(
    toOldRedditUrl('https://www.reddit.com/r/popular/?sort=new'),
    'https://old.reddit.com/r/popular/?sort=new',
  );
  assert.equal(
    toOldRedditUrl('https://reddit.com/best/'),
    'https://old.reddit.com/best/',
  );
});

test('does not rewrite unrelated hosts', () => {
  assert.equal(toOldRedditUrl('https://example.com/'), undefined);
});

test('classifies transient Chromium navigation failures as retryable', () => {
  assert.equal(
    isRetryableRedditNavigationError(
      new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE'),
    ),
    true,
  );
  assert.equal(
    isRetryableRedditNavigationError(
      new Error('page.goto: net::ERR_CONNECTION_RESET'),
    ),
    true,
  );
  assert.equal(
    isRetryableRedditNavigationError(new Error('Reddit returned HTTP 404')),
    false,
  );
});
