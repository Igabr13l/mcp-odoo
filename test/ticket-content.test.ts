import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import type { ExecuteKwImplementation } from "../src/contracts.js";
import {
  createTicketContentTools,
  normalizeAttachmentMetadata,
} from "../src/tools/ticket-content.js";
import {
  array,
  required,
  structuredContent,
  textContent,
} from "./helpers.js";

interface AttachmentMetadata {
  name: string;
  description: string;
  provenance?: {
    task_direct: boolean;
    source_messages: { id?: number; date: string | null }[];
  };
}

interface AttachmentContent extends Record<string, unknown> {
  attachments: AttachmentMetadata[];
}

interface ImageContent extends Record<string, unknown> {
  images: AttachmentMetadata[];
}

function makeTools() {
  const executeKw: ExecuteKwImplementation = async (
    model,
    method,
    args = [],
    kwargs = {},
  ) => {
    if (model === "mail.message" && method === "search_read") {
      return [
        {
          id: 30,
          date: "2026-08-09 09:30:00",
          author_id: [4, "Lin"],
          attachment_ids: [50],
        },
      ];
    }
    if (model === "ir.attachment" && method === "search_read") {
      return [
        {
          id: 51,
          name: "token=direct-filename-secret.txt",
          mimetype: "text/plain",
          file_size: 4,
          type: "binary",
          url: "https://files.example/direct?password=direct-secret",
          description: "<p>token: direct-secret</p>",
          res_model: "project.task",
          res_id: 7,
        },
      ];
    }
    if (model === "ir.attachment" && method === "read") {
      if (array(args[1]).includes("datas")) {
        return [
          {
            id: 50,
            name: "password=image-read-filename-secret.png",
            mimetype: "image/png",
            file_size: 3,
            datas: "aW1hZ2U=",
          },
        ];
      }
      return [
        {
          id: 50,
          name: "secret=image-filename-secret.png",
          mimetype: "image/png",
          file_size: 3,
          type: "binary",
          url: "https://files.example/screen?token=image-secret",
          description: "<p>password: image-secret</p>",
          res_model: "mail.message",
          res_id: 30,
        },
      ];
    }
    throw new Error(`Unexpected call ${model}.${method} ${JSON.stringify(kwargs)}`);
  };
  return createTicketContentTools({ executeKw });
}

test("ticket attachment output includes task-direct and source-message provenance", async () => {
  const result = await makeTools().handlers.odoo_get_ticket_attachments({
    task_id: 7,
  });
  const data = structuredContent<AttachmentContent>(result);

  assert.match(textContent(result), /task-direct/);
  assert.match(textContent(result), /message:30 2026-08-09 09:30:00 Lin/);
  assert.deepEqual(data.attachments[1].provenance, {
    task_direct: false,
    source_messages: [
      {
        id: 30,
        date: "2026-08-09 09:30:00",
        author: { id: 4, name: "Lin" },
      },
    ],
  });
  assert.equal(
    data.attachments[0].description,
    "token: [REDACTED]",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /direct-secret|image-secret|direct-filename-secret|image-filename-secret/,
  );
  assert.match(textContent(result), /token=\[REDACTED\]/);
  assert.equal(data.attachments[0].name, "token=[REDACTED]");
});

test("ticket image output carries attachment provenance in text and structured content", async () => {
  const result = await makeTools().handlers.odoo_get_ticket_images({ task_id: 7 });
  const data = structuredContent<ImageContent>(result);

  assert.match(textContent(result), /message:30 2026-08-09 09:30:00 Lin/);
  assert.equal(result.content[1].type, "image");
  assert.equal(
    required(data.images[0].provenance).source_messages[0].id,
    30,
  );
  assert.equal(
    data.images[0].description,
    "password: [REDACTED]",
  );
  assert.equal(data.images[0].name, "secret=[REDACTED]");
  assert.match(textContent(result), /password=\[REDACTED\]/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /image-secret|image-filename-secret|image-read-filename-secret/,
  );
});

test("attachment metadata normalizer secures video metadata and excludes binary data", () => {
  const metadata = normalizeAttachmentMetadata({
    id: 52,
    name: "<b>token=video-filename-secret.mp4</b>",
    mimetype: "video/mp4",
    datas: "binary-secret",
    description: "<p>token: video-secret</p>",
    url: "https://files.example/video?password=url-secret",
  });
  const output = JSON.stringify(metadata);

  assert.equal(metadata.description, "token: [REDACTED]");
  assert.equal(metadata.name, "token=[REDACTED]");
  assert.equal(metadata.url, "https://files.example/video?password=[REDACTED]");
  assert.equal("datas" in metadata, false);
  assert.doesNotMatch(
    output,
    /video-secret|url-secret|binary-secret|video-filename-secret/,
  );
});

test("odoo_get_ticket_video_frames validates attachment_id as positive integer", async () => {
  await assert.rejects(
    makeTools().handlers.odoo_get_ticket_video_frames({
      task_id: 7,
      attachment_id: 0,
    }),
    /attachment_id must be a positive integer/,
  );
  await assert.rejects(
    makeTools().handlers.odoo_get_ticket_video_frames({
      task_id: 7,
      attachment_id: "abc",
    }),
    /attachment_id must be a positive integer/,
  );
});

function makeGenericAttachmentTools({
  attachment,
  datas,
}: {
  attachment: {
    id: number;
    name: string;
    mimetype: string;
    file_size: number;
  };
  datas: string;
}) {
  const executeKw: ExecuteKwImplementation = async (
    model,
    method,
    args = [],
    kwargs = {},
  ) => {
    if (model === "mail.message" && method === "search_read") {
      return [
        {
          id: 30,
          date: "2026-10-22 17:08:09",
          author_id: [4, "Santino"],
          attachment_ids: [attachment.id],
        },
      ];
    }
    if (model === "ir.attachment" && method === "search_read") {
      return [];
    }
    if (model === "ir.attachment" && method === "read") {
      if (array(args[1]).includes("datas")) {
        return [
          {
            id: attachment.id,
            name: attachment.name,
            mimetype: attachment.mimetype,
            file_size: attachment.file_size,
            datas,
          },
        ];
      }
      return [
        {
          ...attachment,
          type: "binary",
          url: false,
          description: false,
          res_model: "mail.message",
          res_id: 30,
        },
      ];
    }
    throw new Error(`Unexpected call ${model}.${method} ${JSON.stringify(kwargs)}`);
  };
  return createTicketContentTools({ executeKw });
}

test("odoo_get_ticket_attachment reads inline text with secret redaction and provenance", async () => {
  const rawText = "token: inline-secret\nstatus=ok";
  const tools = makeGenericAttachmentTools({
    attachment: {
      id: 70,
      name: "debug.log",
      mimetype: "text/plain",
      file_size: Buffer.byteLength(rawText),
    },
    datas: Buffer.from(rawText, "utf8").toString("base64"),
  });

  const result = await tools.handlers.odoo_get_ticket_attachment({
    task_id: 7,
    attachment_id: 70,
  });
  const data = structuredContent<{
    task_id: number;
    text: string;
    truncated: boolean;
    redacted: boolean;
    is_text: boolean;
    attachment: AttachmentMetadata;
  }>(result);

  assert.equal(data.task_id, 7);
  assert.equal(data.redacted, true);
  assert.equal(data.is_text, true);
  assert.equal(data.truncated, false);
  assert.equal(data.text, "token: [REDACTED]\nstatus=ok");
  assert.equal(required(data.attachment.provenance).source_messages[0].id, 30);
  assert.match(textContent(result), /message:30 2026-10-22 17:08:09 Santino/);
  assert.doesNotMatch(JSON.stringify(result), /inline-secret/);
});

test("odoo_get_ticket_attachment saves redacted valid JSON when save_to_temp is true for HAR files", async () => {
  const harPayload = {
    log: {
      entries: [
        {
          request: {
            url: "https://support-uat.hubeet.com/graphql",
            headers: [
              { name: "Authorization", value: "Bearer har-auth-secret" },
              { name: "Cookie", value: "session_id=har-cookie-secret" },
              { name: "Content-Type", value: "application/json" },
            ],
            cookies: [{ name: "sid", value: "har-sid-secret" }],
            postData: {
              text: JSON.stringify({
                operationName: "getThreadMessagesCopilot",
                variables: { threadUUID: "abc-123" },
              }),
            },
          },
          response: {
            status: 200,
            headers: [{ name: "Set-Cookie", value: "sid=har-set-cookie-secret" }],
            cookies: [{ name: "csrf", value: "har-csrf-secret" }],
          },
        },
      ],
    },
  };
  const rawHar = JSON.stringify(harPayload);
  const tools = makeGenericAttachmentTools({
    attachment: {
      id: 71,
      name: "../capture.har",
      mimetype: "text/plain",
      file_size: Buffer.byteLength(rawHar),
    },
    datas: Buffer.from(rawHar, "utf8").toString("base64"),
  });

  const result = await tools.handlers.odoo_get_ticket_attachment({
    task_id: 7,
    attachment_id: 71,
    save_to_temp: true,
  });
  const data = structuredContent<{
    file_path: string;
    redacted: boolean;
    is_text: boolean;
  }>(result);

  try {
    assert.equal(data.redacted, true);
    assert.equal(data.is_text, true);
    assert.match(data.file_path, /task-7-att-71-capture\.har$/);

    const savedContent = await readFile(data.file_path, "utf8");
    assert.doesNotMatch(
      savedContent,
      /har-auth-secret|har-cookie-secret|har-sid-secret|har-set-cookie-secret|har-csrf-secret/,
    );

    const parsed = JSON.parse(savedContent) as typeof harPayload;
    const entry = parsed.log.entries[0];
    assert.equal(entry.request.headers[0].value, "[REDACTED]");
    assert.equal(entry.request.headers[1].value, "[REDACTED]");
    assert.equal(entry.request.headers[2].value, "application/json");
    assert.equal(entry.request.cookies[0].value, "[REDACTED]");
    assert.equal(entry.response.status, 200);
    assert.equal(entry.response.headers[0].value, "[REDACTED]");
    assert.equal(entry.response.cookies[0].value, "[REDACTED]");
    assert.match(entry.request.postData.text, /getThreadMessagesCopilot/);
  } finally {
    await rm(data.file_path, { force: true });
  }
});

test("odoo_get_ticket_attachment truncates inline text when exceeding max_chars", async () => {
  const rawText = "a".repeat(500);
  const tools = makeGenericAttachmentTools({
    attachment: {
      id: 72,
      name: "large.txt",
      mimetype: "text/plain",
      file_size: rawText.length,
    },
    datas: Buffer.from(rawText, "utf8").toString("base64"),
  });

  const result = await tools.handlers.odoo_get_ticket_attachment({
    task_id: 7,
    attachment_id: 72,
    max_chars: 120,
  });
  const data = structuredContent<{
    text: string;
    total_chars: number;
    truncated: boolean;
  }>(result);

  assert.equal(data.truncated, true);
  assert.equal(data.total_chars, 500);
  assert.equal(data.text.length, 120);
  assert.match(textContent(result), /Pass save_to_temp: true/);
});

test("odoo_get_ticket_attachment enforces ownership, size limit, and binary guard", async () => {
  const binaryTools = makeGenericAttachmentTools({
    attachment: {
      id: 73,
      name: "archive.zip",
      mimetype: "application/zip",
      file_size: 4,
    },
    datas: Buffer.from([1, 2, 3, 4]).toString("base64"),
  });

  await assert.rejects(
    binaryTools.handlers.odoo_get_ticket_attachment({
      task_id: 7,
      attachment_id: 999,
    }),
    /Attachment 999 not found on this ticket/,
  );

  await assert.rejects(
    binaryTools.handlers.odoo_get_ticket_attachment({
      task_id: 7,
      attachment_id: 73,
      max_bytes: 2,
    }),
    /Attachment exceeds the 2 byte limit/,
  );

  await assert.rejects(
    binaryTools.handlers.odoo_get_ticket_attachment({
      task_id: 7,
      attachment_id: 73,
    }),
    /Attachment 73 is binary \(application\/zip\); pass save_to_temp: true/,
  );
});
