"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "landing");

function listFiles(dir, prefix = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name).replace(/\\/g, "/");
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath, relativePath));
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function checkStructuredData(htmlFiles) {
  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

    for (const [index, block] of blocks.entries()) {
      try {
        JSON.parse(block[1]);
      } catch (error) {
        fail(`${file}: invalid ld+json block ${index + 1}: ${error.message}`);
      }
    }
  }
}

function checkSitemap() {
  const sitemapPath = path.join(PUBLIC_DIR, "sitemap.xml");
  const sitemap = fs.readFileSync(sitemapPath, "utf8");

  if (!sitemap.includes("<urlset") || !sitemap.includes("</urlset>")) {
    fail("sitemap.xml: missing urlset wrapper.");
  }

  const urls = [...sitemap.matchAll(/<loc>https:\/\/brograde\.com\/([^<]*)<\/loc>/g)].map((match) => match[1] || "index.html");
  const publicFiles = new Set(listFiles(PUBLIC_DIR));

  for (const urlPath of urls) {
    const normalized = urlPath || "index.html";
    if (normalized === "index.html") continue;
    if (!publicFiles.has(normalized)) {
      fail(`sitemap.xml: ${normalized} is not present in landing/.`);
    }
  }
}

function checkLocalLinks(htmlFiles) {
  const publicFiles = new Set(listFiles(PUBLIC_DIR));

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
    const attributes = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);

    for (const attribute of attributes) {
      const target = attribute.split("#")[0].split("?")[0];
      if (
        !target ||
        target.startsWith("http") ||
        target.startsWith("mailto:") ||
        target.startsWith("tel:") ||
        target.startsWith("app:")
      ) {
        continue;
      }

      if (target === "/") continue;

      const normalized = target.startsWith("/")
        ? target.replace(/^\//, "")
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), target.replace(/^\.\//, "")));
      if (!publicFiles.has(normalized)) {
        fail(`${file}: missing local target ${attribute}`);
      }
    }
  }
}

function checkRobots() {
  const robots = fs.readFileSync(path.join(PUBLIC_DIR, "robots.txt"), "utf8");
  for (const required of ["Sitemap: https://brograde.com/sitemap.xml", "User-agent: GPTBot", "User-agent: OAI-SearchBot"]) {
    if (!robots.includes(required)) {
      fail(`robots.txt: missing ${required}`);
    }
  }
}

function main() {
  const htmlFiles = listFiles(PUBLIC_DIR).filter((file) => file.endsWith(".html"));
  checkStructuredData(htmlFiles);
  checkSitemap();
  checkLocalLinks(htmlFiles);
  checkRobots();

  if (process.exitCode) return;
  console.log(`Site checks OK across ${htmlFiles.length} HTML files.`);
}

main();
