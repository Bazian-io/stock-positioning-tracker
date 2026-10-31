import assert from "node:assert/strict";
import { test } from "node:test";
import { companyName, investorName, shortCompanyName, stockName } from "./names.ts";

test("company names lose the share description, and short names the legal form", () => {
  // Names as listed in Nasdaq's directory of US-listed securities.
  const cases: [string, string, string][] = [
    ["Apple Inc. - Common Stock", "Apple Inc.", "Apple"],
    ["Bank of America Corporation Common Stock", "Bank of America Corporation", "Bank of America"],
    ["Coca-Cola Company (The) Common Stock", "The Coca-Cola Company", "Coca-Cola"],
    ["Berkshire Hathaway Inc. New Common Stock", "Berkshire Hathaway Inc.", "Berkshire Hathaway"],
    ["Alphabet Inc. - Class A Common Stock", "Alphabet Inc.", "Alphabet"],
    ["Chubb Limited  Common Stock", "Chubb Limited", "Chubb"],
    ["Taiwan Semiconductor Manufacturing Company Ltd.", "Taiwan Semiconductor Manufacturing Company Ltd.", "Taiwan Semiconductor Manufacturing"],
    ["Shell PLC American Depositary Shares (each representing two (2) Ordinary Shares) ", "Shell PLC", "Shell"],
    ["JP Morgan Chase & Co. Common Stock", "JP Morgan Chase & Co.", "JP Morgan Chase"],
    ["The Trade Desk, Inc. - Class A Common Stock", "The Trade Desk, Inc.", "The Trade Desk"],
    ["Iron Mountain Incorporated (Delaware)Common Stock REIT", "Iron Mountain Incorporated", "Iron Mountain"],
    ["Geo Group Inc (The) REIT", "The Geo Group Inc", "Geo Group"],
    ["Mizuho Financial Group, Inc. Sponosred ADR (Japan)", "Mizuho Financial Group, Inc.", "Mizuho Financial Group"],
    ["Bank of N.T. Butterfield & Son Limited (The) Voting Ordinary Shares", "The Bank of N.T. Butterfield & Son Limited", "Bank of N.T. Butterfield & Son"],
    ["Liberty Live Holdings, Inc. - Series A Liberty Live Group Common Stock", "Liberty Live Holdings, Inc.", "Liberty Live Holdings"],
    ["United Parks & Resorts Inc. Common Stock", "United Parks & Resorts Inc.", "United Parks & Resorts"],
    ["3M Company Common Stock", "3M Company", "3M"],
    ["HP Inc. Common Stock", "HP Inc.", "HP"],
    ["Visa Inc.", "Visa Inc.", "Visa"],
  ];
  for (const [listed, company, short] of cases) {
    assert.equal(companyName(listed), company, listed);
    assert.equal(shortCompanyName(listed), short, listed);
  }
});

test("pages fall back to the names as filed when no readable name is recorded", () => {
  assert.equal(stockName({ listingName: "NVIDIA Corporation - Common Stock", issuerName: "NVIDIA CORP" }), "NVIDIA");
  assert.equal(stockName({ listingName: null, issuerName: "NVIDIA CORP" }), "NVIDIA CORP");
  assert.equal(investorName({ displayName: "State Street", name: "STATE STREET CORP" }), "State Street");
  assert.equal(investorName({ displayName: null, name: "STATE STREET CORP" }), "STATE STREET CORP");
});
