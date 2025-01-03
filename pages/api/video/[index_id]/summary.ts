import {
  GetIndexSummaryDocument,
  GetIndexSummaryQuery,
  GetIndexSummaryQueryVariables,
  UpdateIndexesDocument,
  UpdateIndexesMutation,
  UpdateIndexesMutationVariables,
} from "@graphql/generated/graphql";
import { TokenTextSplitter } from "langchain/text_splitter";
import { NextFetchEvent, NextResponse } from "next/server";
import baseEdgeHandlerWrapper, { NextRequestCustom } from "src/helpers/baseEdgeHandlerWrapper";
import { handleError } from "src/helpers/error";
import { gqlServerClient } from "src/helpers/graphqlServerClient";
import { jigsaw } from "src/helpers/jigsawstack";
import { HandlerConfig } from "src/types";

export const config = {
  runtime: "edge",
};

const tokenSplitter = new TokenTextSplitter({
  encodingName: "cl100k_base",
  chunkSize: 20000,
  chunkOverlap: 0,
});

const handler = async (req: NextRequestCustom, con: NextFetchEvent) => {
  try {
    const params = req.params;

    const resp = await gqlServerClient.request<GetIndexSummaryQuery, GetIndexSummaryQueryVariables>(GetIndexSummaryDocument, {
      id: params.index_id,
    });

    console.log("index", params);

    const index = resp.indexes_by_pk;

    if (!index?.transcript) {
      throw new Error("Index has no transcript");
    }

    let summaryText = index?.summary_text || null;
    let summaryPoints = index?.summary_points || null;

    if (!summaryText || !summaryPoints) {
      let textToSummarize = index.transcript || "";

      const textArr = await tokenSplitter.splitText(textToSummarize);

      console.log("textArr splits", textArr.length);

      textToSummarize = textArr[0];

      if (!textToSummarize) {
        throw new Error("Text to summarize is empty");
      }

      const summaryResults = await Promise.all([
        jigsaw.summary({
          text: textToSummarize,
          type: "text",
        }),
        jigsaw.summary({
          text: textToSummarize,
          type: "points",
          max_points: 5,
        }),
      ]);

      const summaryTextResult = summaryResults?.[0];
      const summaryPointsResult = summaryResults?.[1];

      console.log("summaryTextResult", summaryTextResult);
      console.log("summaryPointsResult", summaryPointsResult);

      if (!summaryTextResult || !summaryPointsResult) {
        throw new Error("Summary failed");
      }

      const updateRequestPromise = gqlServerClient.request<UpdateIndexesMutation, UpdateIndexesMutationVariables>(UpdateIndexesDocument, {
        where: {
          id: {
            _eq: params.index_id,
          },
        },
        _set: {
          summary_text: summaryTextResult.summary,
          summary_points: summaryPointsResult.summary,
        },
      });

      con.waitUntil(updateRequestPromise);

      summaryText = summaryTextResult.summary;
      summaryPoints = summaryPointsResult.summary;
    }

    return NextResponse.json(
      {
        success: true,
        summary_text: summaryText,
        summary_points: summaryPoints,
      },
      {
        status: 200,
        headers: {
          "cache-control": "public, s-maxage=2592000",
        },
      }
    );
  } catch (error) {
    return handleError(error);
  }
};

export const handlerConfig: HandlerConfig = {
  method: ["GET"],
  skipAuth: true,
};

export default baseEdgeHandlerWrapper(handler, handlerConfig);
