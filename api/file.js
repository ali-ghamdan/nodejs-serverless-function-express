import fs from "node:fs";
import os from "node:os";
import { parseHTML } from "linkedom";
import path from "node:path";
import Epub from "epub-gen";

import A from "../articles.json" with {type: "json"};
let articles = A;
let titles;

export default async function handler(req, res) {
  titles = new Set(articles.map((e) => e.title));
  const file = await convertToEpub(articles);
  await scrapeAllArticles();
  articles = articles.sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  res.setHeader("Content-Type", "application/epub+zip");
  res.setHeader("Content-Disposition", 'attachment; filename="file.epub"');

  res.send(file);
}

async function convertToEpub(articles) {
  let sections = articles.map((art, i) => {
    let document = parseHTML(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>مقالات الشيخ أبو جعفر الخليفي</title>
  <style>
    .home {
      font-size: 30px;
      font-family: Arial, Helvetica, sans-serif;
      direction: rtl !important;
      line-height: 45px;
      padding: 20px;
      text-decoration: none;
    }
    h2 {
      line-height: 50px;
    }
  </style>
</head>
<body>
  <h3></h3>
  <div class="home">
    <div class="list">
      <center>
        <h1>قائمة المقالات</h1>
      </center>
      <hr>
      <ul class="tree">
        <!-- <li class="tree-content"></li> -->
      </ul>
      <hr>  
    </div>
    <div class="articles">
      <!-- <div class="article">
        <center>
          <h2 class="article-title" id="aID"><a href="url">title</a></h2>
        </center>
        <div class="article-content">
          <p></p>
        </div>
      </div> -->
    </div>
  </div>
</body>
</html>`
    ).document;
    document.querySelector(".list")?.remove();
    let a = document.createElement("div");
    a.classList.add("article");
    a.innerHTML = `
<center>
  <h2 class="article-title"><a href="${art.url}">${art.title}</a></h2>
</center>
<div class="article-content">
  ${art.content}
</div>
`;

    document.querySelector(".articles")?.appendChild(a);

    for (let d of document.querySelectorAll(
      "div.article div.entry-content *"
    )) {
      for (let attr of d.attributes) {
        d.removeAttribute(attr.name);
      }
    }
    for (let img of document.querySelectorAll("img")) {
      img.remove();
    }
    let data = document.documentElement.outerHTML;
    return {
      title: art.title,
      data,
      filename: `article-${String(i)}.xhtml`,
    };
  });
  let out = tmpFile("articles.epub");

  await new Epub(
    {
      title: "مقالات الشيخ أبو جعفر عبد الله الخليفي",
      author: "أبو جعفر عبد الله بن فهد الخليفي",
      css: "* { direction: rtl }",
      //@ts-ignore
      ignoreFailedDownloads: true,
      numberChaptersInTOC: false,
      tocInTOC: false,
      verbose: true,
      tocXHTML: "",
      tocTitle: "فهرس المقالات",
      content: sections,
      appendChapterTitles: false,
    },
    out
  ).promise;

  let output = await fs.promises.readFile(out);
  fs.rmSync(out, { force: true, recursive: true });
  return output;
}

async function scrapeAllArticles() {
  let html = await fetchURL(
    "https://alkulify.com/%D9%83%D9%84-%D8%A7%D9%84%D9%85%D9%82%D8%A7%D9%84%D8%A7%D8%AA/",
    1
  );

  let document = parseHTML(html).document;
  let nextPage;

  let n = 0;
  do {
    console.log(++n, "fetching..., articles numbers:", articles.length);
    nextPage = document.querySelector(
      "main div nav a.wp-block-query-pagination-next"
    )?.href;

    const ArticleList = Array.from(
      document.querySelectorAll("main div div ul li")
    );
    console.log(ArticleList.length, { nextPage });
    for (let i = 0; i < ArticleList.length; i++) {
      const { title, url, categories, date } = getArticleBasicData(
        ArticleList[i]
      );
      if (titles.has(title)) continue;

      try {
        await getArticleData(url, categories, date, title);
        console.log(`🗹 fetching(${i + 1}/${ArticleList.length}):`, title);
        titles.add(title);
      } catch (error) {
        console.error(error);
        console.log(
          `❌ fetching(${i + 1}/${ArticleList.length} failed):`,
          title
        );
      }
    }
    console.log(titles.size);
    if (!nextPage) break;
    html = await fetchURL(nextPage, 3);
    document = parseHTML(html).document;
  } while (typeof nextPage === "string");

  console.log("finished scraping all articles.");

  await saveArticles();
}

/**
 *
 * @param {Element} article
 */
function getArticleBasicData(article) {
  const { textContent: title, href: url } = article.querySelector(
    "h2.wp-block-post-title a"
  );

  const date = new Date(
    article
      .querySelector("div.wp-block-post-date time[datetime]")
      ?.getAttribute("datetime")
  );

  const categories = Array.from(
    article.querySelectorAll("div.wp-block-post-terms a[rel=tag]")
  ).map((x) => ({ category: x.textContent, url: x.href }));

  return { title, url, date, categories };
}

async function getArticleData(url, categories, date, title) {
  let html = await fetchURL(url, 3);
  let doc = parseHTML(html).document;
  doc.querySelector("main > div")?.remove();
  let content = `${doc.querySelector("main div")}\n${doc.querySelector(
    "main div + div"
  )}`;
  let tags = Array.from(
    doc.querySelectorAll("main .wp-block-post-terms a")
  ).map((e) => ({ tag: e.textContent, url: e.href }));
  let related = Array.from(
    doc.querySelectorAll("main + div div.wp-block-query ul li a")
  ).map((e) => ({ tag: e.textContent, url: e.href }));

  articles.push({ title, url, date, content, categories, tags, related });
}

/**
 *
 * @param {string} url
 * @param {number} count
 */
async function fetchURL(url, count) {
  if (typeof count !== "number") count = 0;

  try {
    return await fetch(url).then((res) => {
      if (String(res.status)[0] !== "2") throw new Error("Fails");
      return res.text();
    });
  } catch (error) {
    if (count > 0) return fetchURL(url, count - 1);
    else throw error;
  }
}

async function saveArticles() {
  return;
}

function tmpFile(name = "tmp") {
  return path.join(
    os.tmpdir(),
    `${String(Math.random()).replace(".", "")}_${name}`
  );
}
