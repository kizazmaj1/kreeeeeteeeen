/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/



import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { Frame } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const imageModel = 'gemini-2.5-flash-image';

export interface AnimationAssets {
  imageData: { data: string, mimeType: string };
  frames: Frame[];
  frameDuration: number;
}

const base64ToGenerativePart = (base64: string, mimeType: string) => {
    return {
      inlineData: {
        data: base64,
        mimeType,
      },
    };
};

export const generateAnimationAssets = async (
    base64UserImage: string | null,
    mimeType: string | null,
    imagePrompt: string,
    onProgress: (message: string) => void
): Promise<AnimationAssets | null> => {
  try {
    const imageGenTextPart = { text: imagePrompt };
    const parts = [];

    if (base64UserImage && mimeType) {
        const userImagePart = base64ToGenerativePart(base64UserImage, mimeType);
        parts.push(userImagePart);
    }
    parts.push(imageGenTextPart);
    
    const imageGenResponse: GenerateContentResponse = await ai.models.generateContent({
        model: imageModel,
        contents: [{
            role: "user",
            parts: parts,
        }],
    });

    const responseParts = imageGenResponse.candidates?.[0]?.content?.parts;
    if (!responseParts) {
        throw new Error("Invalid response from model. No parts found.");
    }

    const imagePart = responseParts.find(p => p.inlineData);
    if (!imagePart?.inlineData?.data) {
        console.error("No image part found in response from image generation model", imageGenResponse);
        const text = responseParts.find(p => p.text)?.text;
        throw new Error(`Model did not return an image. Response: ${text ?? "<no text>"}`);
    }
    const imageData = { data: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType };
    
    // Smart heuristic for animation frame duration based on prompt keywords
    let frameDuration = 150; // Default fallback value
    const promptLower = imagePrompt.toLowerCase();
    if (
        promptLower.includes('slow') ||
        promptLower.includes('maker') ||
        promptLower.includes('story') ||
        promptLower.includes('chill') ||
        promptLower.includes('pencil') ||
        promptLower.includes('sketch') ||
        promptLower.includes('stop-motion') ||
        promptLower.includes('stop motion')
    ) {
        frameDuration = 250;
    } else if (
        promptLower.includes('fast') ||
        promptLower.includes('speed') ||
        promptLower.includes('run') ||
        promptLower.includes('rapid') ||
        promptLower.includes('quick') ||
        promptLower.includes('spin') ||
        promptLower.includes('game') ||
        promptLower.includes('dynamic')
    ) {
        frameDuration = 100;
    }

    return { imageData, frames: [], frameDuration };
  } catch (error) {
    console.error("Error during asset generation:", error);
    throw new Error(`Failed to process image. ${error instanceof Error ? error.message : ''}`);
  }
};
