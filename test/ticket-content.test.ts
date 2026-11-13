import assert from "node:assert/strict";
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
