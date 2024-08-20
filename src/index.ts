import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import puppeteer from 'puppeteer-extra';
import Stealth from 'puppeteer-extra-plugin-stealth';
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha';
import dotenv from 'dotenv';
import { Browser, Page } from 'puppeteer';

dotenv.config();

const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

interface TweetInfo {
  id: string;
  likes: number;
  retweets: number;
  replies: number;
  content: string;
  media?: string;
  thumbnail?: string;
}

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
];

function getRandomUserAgent(): string {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

async function simulateHumanInteraction(page: Page): Promise<void> {
  await page.mouse.move(100, 100);
  await page.waitForTimeout(2000);
  await page.mouse.move(200, 200);
  await page.waitForTimeout(2000);
  await page.mouse.move(300, 300);
  await page.waitForTimeout(2000);
}

async function scrollAndCollectLinks(
  page: Page,
  collectedTweetIds: Set<string>,
  maxTweets?: number
): Promise<void> {
  let scrolling = true;

  while (
    scrolling &&
    (maxTweets === undefined || collectedTweetIds.size < maxTweets)
  ) {
    await page.evaluate('window.scrollBy(0, 100)');
    await page.waitForTimeout(2000);

    const newTweetLinks = await page.evaluate((selector: string) => {
      const tweetElements = document.querySelectorAll(selector);
      const links: string[] = [];
      tweetElements.forEach(element => {
        const linkElement = element.querySelector('a[href*="/status/"]');
        if (linkElement) {
          const link = linkElement.getAttribute('href');
          if (link) {
            links.push(link);
          }
        }
      });
      return links;
    }, 'article[data-testid="tweet"]');

    newTweetLinks.forEach(link => {
      if (
        !collectedTweetIds.has(link) &&
        (maxTweets === undefined || collectedTweetIds.size < maxTweets)
      ) {
        collectedTweetIds.add(link);
        console.log(
          `\x1b[34m[COLLECT LINKS]\x1b[0m`,
          `Collected new tweet link: ${link}`
        );
      }
    });

    const scrolledToBottom = await page.evaluate(() => {
      return window.innerHeight + window.scrollY >= document.body.scrollHeight;
    });

    if (
      scrolledToBottom ||
      (maxTweets !== undefined && collectedTweetIds.size >= maxTweets)
    ) {
      scrolling = false;
    }
  }

  console.log(
    `\x1b[34m[COLLECT LINKS]\x1b[0m`,
    `Total collected: ${collectedTweetIds.size}`
  );
}

async function collectTweetData(
  page: Page,
  tweetUrl: string
): Promise<TweetInfo | null> {
  await page.setUserAgent(getRandomUserAgent());

  await page.goto(`https://twitter.com${tweetUrl}`, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  await page.waitForTimeout(3000);

  const tweetDetails = await page.evaluate(() => {
    const parseNumber = (numberString: string): number => {
      let number = parseFloat(numberString.replace(/,/g, ''));
      if (numberString.includes('k')) {
        number *= 1000;
      } else if (numberString.includes('M')) {
        number *= 1000000;
      }
      return isNaN(number) ? 0 : Math.round(number);
    };

    const id = window.location.pathname.split('/').pop() || '';
    const contentElement = document.querySelector('div[lang]');
    const content = contentElement ? contentElement.textContent || '' : '';

    // Captura a mídia anexada ao tweet
    const mediaElement = document.querySelector(
      'article img.css-9pa8cd, article video'
    );
    const media = mediaElement ? (mediaElement as HTMLImageElement).src : '';

    const likesElement = document.querySelector(
      'a[href*="/likes"] > div > span:first-of-type'
    );
    const likes = likesElement
      ? parseNumber(likesElement.textContent || '0')
      : 0;

    const retweetsElement = document.querySelector(
      'a[href*="/retweets"] > div > span:first-of-type'
    );
    const retweets = retweetsElement
      ? parseNumber(retweetsElement.textContent || '0')
      : 0;

    const repliesElement = document.querySelector(
      'a[href*="/retweets/with_comments"] > div > span:first-of-type'
    );
    const replies = repliesElement
      ? parseNumber(repliesElement.textContent || '0')
      : 0;

    return {
      id,
      likes,
      retweets,
      replies,
      content,
      media,
      thumbnail: media // A 'thumbnail' agora reflete a imagem principal
    };
  });

  if (tweetDetails && tweetDetails.id) {
    return tweetDetails;
  }
  return null;
}

async function getTwitterProfileInfo(
  username: string,
  maxTweets?: number
): Promise<{
  tweetData: TweetInfo[];
  totalLikes: number;
  totalRetweets: number;
  totalReplies: number;
}> {
  await puppeteer.use(Stealth());
  await puppeteer.use(
    RecaptchaPlugin({
      provider: {
        id: '2captcha',
        token: process.env.RECAPTCHA_TOKEN || ''
      },
      visualFeedback: true
    })
  );

  const browser: Browser = await puppeteer.launch({ headless: false });
  const page: Page = await browser.newPage();

  try {
    await page.setUserAgent(getRandomUserAgent());

    const url = `https://twitter.com/${username}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    await simulateHumanInteraction(page);

    const collectedTweetIds = new Set<string>();

    await scrollAndCollectLinks(page, collectedTweetIds, maxTweets);

    let allTweetData: TweetInfo[] = [];
    let totalLikes = 0;
    let totalRetweets = 0;
    let totalReplies = 0;

    for (const link of collectedTweetIds) {
      const tweetData = await collectTweetData(page, link);
      if (tweetData) {
        allTweetData.push(tweetData);
        totalLikes += tweetData.likes;
        totalRetweets += tweetData.retweets;
        totalReplies += tweetData.replies;
      }

      console.log(
        `\x1b[34m[PROCESSING]\x1b[0m`,
        `Collected data for tweet URL: ${link}`
      );
    }

    console.log(
      `\x1b[34m[FINAL]\x1b[0m`,
      `Total tweets collected: ${allTweetData.length}`
    );
    console.log(`\x1b[34m[FINAL]\x1b[0m`, `Total likes: ${totalLikes}`);
    console.log(`\x1b[34m[FINAL]\x1b[0m`, `Total retweets: ${totalRetweets}`);
    console.log(`\x1b[34m[FINAL]\x1b[0m`, `Total replies: ${totalReplies}`);

    return {
      tweetData: allTweetData,
      totalLikes,
      totalRetweets,
      totalReplies
    };
  } catch (error) {
    console.error('Error in getTwitterProfileInfo:', error);
    return {
      tweetData: [],
      totalLikes: 0,
      totalRetweets: 0,
      totalReplies: 0
    };
  } finally {
    await browser.close();
  }
}

async function collectTweetDataByUrl(
  page: Page,
  tweetUrl: string
): Promise<TweetInfo | null> {
  await page.setUserAgent(getRandomUserAgent());
  await page.goto(tweetUrl, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });
  await page.waitForTimeout(3000);

  const tweetDetails = await page.evaluate(() => {
    const parseNumber = (numberString: string): number => {
      let number = parseFloat(numberString.replace(/,/g, ''));
      if (numberString.includes('k')) {
        number *= 1000;
      } else if (numberString.includes('M')) {
        number *= 1000000;
      }
      return isNaN(number) ? 0 : Math.round(number);
    };

    const id = window.location.pathname.split('/').pop() || '';
    const contentElement = document.querySelector('div[lang]');
    const content = contentElement ? contentElement.textContent || '' : '';

    // Captura a mídia anexada ao tweet
    const mediaElement = document.querySelector(
      'article img.css-9pa8cd, article video'
    );
    const media = mediaElement ? (mediaElement as HTMLImageElement).src : '';

    const likesElement = document.querySelector(
      'a[href*="/likes"] > div > span:first-of-type'
    );
    const likes = likesElement
      ? parseNumber(likesElement.textContent || '0')
      : 0;

    const retweetsElement = document.querySelector(
      'a[href*="/retweets"] > div > span:first-of-type'
    );
    const retweets = retweetsElement
      ? parseNumber(retweetsElement.textContent || '0')
      : 0;

    const repliesElement = document.querySelector(
      'a[href*="/retweets/with_comments"] > div > span:first-of-type'
    );
    const replies = repliesElement
      ? parseNumber(repliesElement.textContent || '0')
      : 0;

    return {
      id,
      likes,
      retweets,
      replies,
      content,
      media,
      thumbnail: media // A 'thumbnail' agora reflete a imagem principal
    };
  });

  if (tweetDetails && tweetDetails.id) {
    return tweetDetails;
  }
  return null;
}

app
  .post('/scrape/limited', async (req: Request, res: Response) => {
    console.log(`\x1b[34m[SCRAPPER]\x1b[0m`, `Starting Scrapper with limit.`);

    const { username, maxTweets } = req.body;

    if (!username || !maxTweets || isNaN(maxTweets) || maxTweets <= 0) {
      return res.status(400).json({
        success: false,
        message:
          'Parâmetros inválidos. Por favor, forneça um username e um número máximo de tweets válido.'
      });
    }

    console.log(
      `\x1b[34m[NEW POST]\x1b[0m`,
      `New Post using username: ${username} with a limit of ${maxTweets} tweets.`
    );

    const { tweetData, totalLikes, totalRetweets, totalReplies } =
      await getTwitterProfileInfo(username, maxTweets);

    res.json({
      success: true,
      data: tweetData,
      totalLikes,
      totalRetweets,
      totalReplies
    });
  })

  .post('/scrape/total', async (req: Request, res: Response) => {
    console.log(
      `\x1b[34m[SCRAPPER]\x1b[0m`,
      `Starting Scrapper for all tweets.`
    );

    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        message: 'Parâmetro inválido. Por favor, forneça um username válido.'
      });
    }

    console.log(
      `\x1b[34m[NEW POST]\x1b[0m`,
      `New Post using username: ${username} to scrape all tweets.`
    );

    const { tweetData, totalLikes, totalRetweets, totalReplies } =
      await getTwitterProfileInfo(username);

    res.json({
      success: true,
      data: tweetData,
      totalLikes,
      totalRetweets,
      totalReplies
    });
  })

  .post('/scrape/tweet', async (req: Request, res: Response) => {
    console.log(
      `\x1b[34m[SCRAPPER]\x1b[0m`,
      `Starting Scrapper for single tweet.`
    );

    const { tweetUrl } = req.body;

    if (!tweetUrl || !tweetUrl.includes('x.com')) {
      return res.status(400).json({
        success: false,
        message:
          'Parâmetro inválido. Por favor, forneça uma URL válida do tweet.'
      });
    }

    const browser: Browser = await puppeteer.launch({ headless: false });
    const page: Page = await browser.newPage();

    try {
      await page.setUserAgent(getRandomUserAgent());

      console.log(
        `\x1b[34m[NEW POST]\x1b[0m`,
        `Fetching data for tweet: ${tweetUrl}`
      );

      const tweetData = await collectTweetDataByUrl(page, tweetUrl);

      res.json({
        success: true,
        data: tweetData
      });
    } catch (error) {
      console.error('Error in /scrape/tweet:', error);
      res.status(500).json({
        success: false,
        message: 'Ocorreu um erro ao processar o tweet.'
      });
    } finally {
      await browser.close();
    }
  });

app.listen(PORT, () =>
  console.log(`\x1b[34m[PORT]\x1b[0m`, `Server is running on port ${PORT}`)
);
