/**
 * 许可链路自检：生成密钥对 → 服务端签发 → 客户端验签 → 篡改必被拒。
 * 运行：node src/license-selftest.mjs
 */

import { generateLicenseKeyPair, issueLicenseToken, LicenseVerifier, LicenseStore, DEFAULT_PLANS } from "./core/license.js";

const results = [];
const record = (name, value) => results.push([name, value]);

const { publicKeyPem, privateKeyPem } = generateLicenseKeyPair();
const issuer = "https://license.example.test";
const verifier = new LicenseVerifier({ publicKeyPem, issuer, audience: "bridge-replica-desktop" });

// 1) 正常签发 + 验签
const token = issueLicenseToken({
  privateKeyPem, issuer, subject: "github:12345",
  installationId: "install-abc", features: ["bridge", "tunnel"],
  ttlSeconds: 3600, entitlementExpiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
});
const good = verifier.verify(token);
record("正常令牌验签", `通过｜sub=${good.claims.sub}｜features=${good.claims.features.join(",")}`);
record("功能位检查 bridge", String(verifier.hasFeature(good.claims, "bridge")));
record("功能位检查 不存在的功能", String(verifier.hasFeature(good.claims, "enterprise")));

// 2) 篡改 payload（改 features）必被拒
const [h, p, s] = token.split(".");
const tamperedPayload = Buffer.from(JSON.stringify({ ...good.claims, features: ["bridge", "enterprise"] })).toString("base64url");
let tamperResult = "未被拒绝（异常！）";
try { verifier.verify(`${h}.${tamperedPayload}.${s}`); } catch (error) { tamperResult = `已拒绝：${error.message}`; }
record("篡改 features 后验签", tamperResult);

// 3) 换一把私钥签的令牌必被拒
const other = generateLicenseKeyPair();
const foreign = issueLicenseToken({ privateKeyPem: other.privateKeyPem, issuer, subject: "attacker", features: ["bridge"] });
let foreignResult = "未被拒绝（异常！）";
try { verifier.verify(foreign); } catch (error) { foreignResult = `已拒绝：${error.message}`; }
record("他人私钥签发", foreignResult);

// 4) 过期令牌必被拒
const expired = issueLicenseToken({ privateKeyPem, issuer, subject: "github:1", features: ["bridge"], ttlSeconds: -10 });
let expiredResult = "未被拒绝（异常！）";
try { verifier.verify(expired); } catch (error) { expiredResult = `已拒绝：${error.message}`; }
record("过期令牌", expiredResult);

// 5) aud 不匹配必被拒（防止把给别的客户端的令牌拿来用）
const wrongAud = issueLicenseToken({ privateKeyPem, issuer, audience: "someone-else", subject: "x", features: ["bridge"] });
let audResult = "未被拒绝（异常！）";
try { verifier.verify(wrongAud); } catch (error) { audResult = `已拒绝：${error.message}`; }
record("aud 不匹配", audResult);

// 6) 本地状态存储
const store = new LicenseStore({ dataHome: process.env.TEMP ? `${process.env.TEMP}\\bridge-license-test` : "/tmp/bridge-license-test" });
await store.write({ token, account: { login: "tester" } });
const status = await store.status(verifier);
record("本地状态汇总", `signedIn=${status.signedIn} licensed=${status.licensed} features=${status.features?.join(",")} 到期=${status.expiresAt}`);
await store.clear();
record("清空后状态", JSON.stringify(await store.status(verifier)));

record("付费套餐", DEFAULT_PLANS.map(p => `${p.planId}/${p.amount}${p.currency}/${p.days}天`).join(" "));

const width = Math.max(...results.map(([name]) => name.length));
for (const [name, value] of results) console.log(`${name.padEnd(width)}  :  ${value}`);
