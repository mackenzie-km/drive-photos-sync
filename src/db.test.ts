const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

// We mock `pg` itself rather than `./db` because resetStuckFiles holds a closure over `query`
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

import { resetStuckFiles } from "./db";

describe("resetStuckFiles", () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it("resets in_progress files back to uninitialized for the given user", async () => {
    await resetStuckFiles("user-123");

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'uninitialized'"),
      ["user-123"],
    );
  });

  it("only targets in_progress files, not other statuses", async () => {
    await resetStuckFiles("user-123");

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("status = 'in_progress'");
  });

  it("scopes the update to the correct user", async () => {
    await resetStuckFiles("user-abc");

    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain("user-abc");
  });
});
