import { describe, expect, it } from "vitest";
import { buildClsUrl } from "../lib/fetch-source";

describe("CLS request signing", () => {
  it("matches the public web client's SHA1 then MD5 signature", async () => {
    expect(await buildClsUrl()).toBe(
      "https://www.cls.cn/v3/depth/home/assembled/1000?app=CailianpressWeb&os=web&sv=8.7.9&sign=b02d8f7bc4c45eeb3e86904203597da2",
    );
  });
});
