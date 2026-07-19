const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

// We mock `pg` itself rather than `./db` because resetStuckFiles holds a closure over `query`
jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation(() => ({ query: mockQuery })),
}));

import {
  resetStuckFiles,
  upsertDriveFile,
  getUninitializedFiles,
  clearPendingFiles,
  clearFailedFiles,
} from "./db";

describe("upsertDriveFile", () => {
  beforeEach(() => mockQuery.mockClear());

  it("inserts folder_id into the row", async () => {
    await upsertDriveFile("file-1", "user-1", "folder-1", "photo.jpg", "abc123", "image/jpeg", 1024);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("folder_id");
    expect(params).toContain("folder-1");
  });

  it("updates folder_id on conflict when status is uninitialized", async () => {
    await upsertDriveFile("file-1", "user-1", "folder-1", "photo.jpg", "abc123", "image/jpeg", 1024);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("ON CONFLICT");
    expect(sql).toContain("folder_id");
    expect(sql).toContain("status = 'uninitialized'");
  });
});

describe("getUninitializedFiles", () => {
  beforeEach(() => mockQuery.mockClear());

  it("is not scoped to any folder — global across all of the user's folders", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getUninitializedFiles("user-1");

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("folder_id");
    expect(params).toEqual(["user-1"]);
  });

  it("includes failed files with retry_count below the limit", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getUninitializedFiles("user-1");

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("retry_count < 3");
  });
});

describe("clearPendingFiles", () => {
  beforeEach(() => mockQuery.mockClear());

  it("deletes all uninitialized files for the user, across every folder", async () => {
    await clearPendingFiles("user-1");

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toContain("folder_id");
    expect(sql).toContain("status = 'uninitialized'");
    expect(params).toEqual(["user-1"]);
  });
});

describe("clearFailedFiles", () => {
  beforeEach(() => mockQuery.mockClear());

  it("deletes only failed files for the given folder", async () => {
    await clearFailedFiles("user-1", "folder-abc");

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("folder_id");
    expect(sql).toContain("status = 'failed'");
    expect(params).toEqual(["user-1", "folder-abc"]);
  });
});

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
