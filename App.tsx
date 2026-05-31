/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/


import React, { useState, useCallback, useRef, useEffect } from 'react';
import { AppState } from './types';
import { generateAnimationAssets, AnimationAssets } from './services/geminiService';
import { buildCreativeInstruction, promptSuggestions } from './prompts';
import CameraView, { CameraViewHandles } from './components/CameraView';
import AnimationPlayer from './components/AnimationPlayer';
import LoadingOverlay from './components/LoadingOverlay';
import { UploadIcon, SwitchCameraIcon, XCircleIcon, CameraIcon } from './components/icons';
import BanamimatorButton from './components/BanamimatorButton';

// --- FEATURE FLAGS ---
// Set to `true` to make uploading or capturing an image mandatory to create an animation.
// Set to `false` to allow creating animations from only a text prompt.
const REQUIRE_IMAGE_FOR_ANIMATION = true;

// Set to `true` to allow selecting multiple emoji suggestions to combine prompts.
// Set to `false` to only allow one emoji suggestion to be active at a time.
const ALLOW_MULTIPLE_EMOJI_SELECTION = false;

const resizeImage = (dataUrl: string, maxWidth: number, maxHeight: number): Promise<string> => {
  // We assume maxWidth and maxHeight are the same and represent the target square size.
  const targetSize = maxWidth; 
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      console.log(`[DEBUG] Original image dimensions: ${img.naturalWidth}x${img.naturalHeight}`);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        return reject(new Error('Could not get canvas context for resizing.'));
      }

      canvas.width = targetSize;
      canvas.height = targetSize;

      const { width, height } = img;
      let sx, sy, sWidth, sHeight;

      // This logic finds the largest possible square in the center of the image
      if (width > height) { // Landscape
        sWidth = height;
        sHeight = height;
        sx = (width - height) / 2;
        sy = 0;
      } else { // Portrait or square
        sWidth = width;
        sHeight = width;
        sx = 0;
        sy = (height - width) / 2;
      }
      
      // Draw the cropped square from the source image onto the target canvas, resizing it in the process.
      ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, targetSize, targetSize);
      
      // Force JPEG format for smaller file size, which is better for uploads.
      const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
      resolve(resizedDataUrl);
    };
    img.onerror = () => {
      reject(new Error('Failed to load image for resizing.'));
    };
    img.src = dataUrl;
  });
};

const App: React.FC = () => {
  const [appState, setAppState] = useState<AppState>(AppState.Capturing);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [animationAssets, setAnimationAssets] = useState<AnimationAssets | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [storyPrompt, setStoryPrompt] = useState<string>('');
  const [typedPlaceholder, setTypedPlaceholder] = useState('');
  const [isPromptFocused, setIsPromptFocused] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraViewRef = useRef<CameraViewHandles>(null);
  const storyPromptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const shouldAnimateAfterCapture = useRef<boolean>(false);
  const typingAnimationRef = useRef<any>(null);
  const promptWasInitiallyEmpty = useRef<boolean>(false);

  useEffect(() => {
    const checkForMultipleCameras = async () => {
      if (navigator.mediaDevices?.enumerateDevices) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputCount = devices.filter(d => d.kind === 'videoinput').length;
          setHasMultipleCameras(videoInputCount > 1);
        } catch (err) {
          console.error("Failed to enumerate media devices:", err);
        }
      }
    };
    checkForMultipleCameras();
  }, []);
  
  useEffect(() => {
    const startTypingAnimation = () => {
        // Clear any existing animation
        if (typingAnimationRef.current?.timeoutId) {
            clearTimeout(typingAnimationRef.current.timeoutId);
        }

        typingAnimationRef.current = {
            ...typingAnimationRef.current,
            fullText: "'stop-motion animation of...'",
            isDeleting: false,
            text: '',
            timeoutId: null,
            speed: 100,
        };

        const tick = () => {
            const state = typingAnimationRef.current;
            if (!state) return;
            let { fullText, isDeleting, text } = state;

            if (isDeleting) {
                text = fullText.substring(0, text.length - 1);
            } else {
                text = fullText.substring(0, text.length + 1);
            }
            
            setTypedPlaceholder(text);

            let newSpeed = state.speed;
            if(isDeleting) newSpeed /= 2;

            if (!isDeleting && text === fullText) {
                newSpeed = 2000; // Pause at end
                state.isDeleting = true;
            } else if (isDeleting && text === '') {
                state.isDeleting = false;
                newSpeed = 500; // Pause at start
            }

            state.text = text;
            state.timeoutId = setTimeout(tick, newSpeed);
        };
        
        typingAnimationRef.current.timeoutId = setTimeout(tick, typingAnimationRef.current.speed);
    };

    const stopTypingAnimation = () => {
        if (typingAnimationRef.current?.timeoutId) {
            clearTimeout(typingAnimationRef.current.timeoutId);
            typingAnimationRef.current.timeoutId = null;
        }
        setTypedPlaceholder('');
    };

    if (!storyPrompt.trim() && !isPromptFocused) {
        startTypingAnimation();
    } else {
        stopTypingAnimation();
    }

    // Cleanup on unmount
    return () => {
        if (typingAnimationRef.current?.timeoutId) {
            clearTimeout(typingAnimationRef.current.timeoutId);
        }
    };
  }, [storyPrompt, isPromptFocused]);

  const FRAME_COUNT = 9;
  const SPRITE_SHEET_WIDTH = 1024;
  const SPRITE_SHEET_HEIGHT = 1024;

  const handleCreateAnimation = useCallback(async (isRegeneration: boolean = false) => {
    const currentPrompt = storyPrompt.trim();
    let finalPrompt = currentPrompt;

    if (!isRegeneration) {
        promptWasInitiallyEmpty.current = !currentPrompt;
    }

    const shouldPickRandomPrompt = !currentPrompt || (isRegeneration && promptWasInitiallyEmpty.current);

    if (shouldPickRandomPrompt) {
        // Filter out banana prompt
        const baseSuggestions = promptSuggestions.filter(p => p.emoji !== '🍌');

        // Filter out the current prompt if it exists, to try and get a new one
        let suggestionsToChooseFrom = baseSuggestions.filter(p => p.prompt !== currentPrompt);

        // If filtering leaves an empty pool (e.g., current prompt was the only one),
        // fall back to the full non-banana list.
        if (suggestionsToChooseFrom.length === 0) {
             suggestionsToChooseFrom = baseSuggestions;
        }

        if (suggestionsToChooseFrom.length > 0) {
            const randomSuggestion = suggestionsToChooseFrom[Math.floor(Math.random() * suggestionsToChooseFrom.length)];
            finalPrompt = randomSuggestion.prompt;
            setStoryPrompt(finalPrompt);
        }
    }

    // This check is now based on the potentially updated finalPrompt
    if (!originalImage && !finalPrompt) {
        return;
    }

    // We MUST re-calculate the instruction here using the `finalPrompt` variable,
    // as the `storyPrompt` state might be stale for this specific execution context.
    const finalCreativeInstruction = buildCreativeInstruction(finalPrompt, originalImage, FRAME_COUNT);

    setAppState(AppState.Processing);
    setError(null);
    
    let base64Image: string | null = null;
    let mimeType: string | null = null;

    try {
      if (originalImage) {
        setLoadingMessage('Optimizing image...');
        const resizedImage = await resizeImage(originalImage, 1024, 1024);
        const imageParts = resizedImage.match(/^data:(image\/(?:jpeg|png|webp));base64,(.*)$/);
        if (!imageParts || imageParts.length !== 3) {
          throw new Error("Could not process the resized image data.");
        }
        mimeType = imageParts[1];
        base64Image = imageParts[2];
      }
      
      setLoadingMessage('Generating sprite sheet...');

      const imageGenerationPrompt = `
PRIMARY GOAL: Generate a single animated sprite sheet image.

You are an expert animator. Your task is to create a ${FRAME_COUNT}-frame animated sprite sheet.
${finalCreativeInstruction}

IMAGE OUTPUT REQUIREMENTS:
- The output MUST be a single, square image file.
- The image MUST be precisely ${SPRITE_SHEET_WIDTH}x${SPRITE_SHEET_HEIGHT} pixels.
- The image must contain ${FRAME_COUNT} animation frames arranged in a 3x3 grid (3 rows, 3 columns).
- Do not add numbers to the frames.
- DO NOT return any text or JSON. Only the image is required.`;
      
      const generatedAsset = await generateAnimationAssets(
          base64Image,
          mimeType,
          imageGenerationPrompt,
          (message: string) => setLoadingMessage(message)
      );

      if (!generatedAsset || !generatedAsset.imageData.data) {
        throw new Error(`Sprite sheet generation failed. Did not receive a valid image.`);
      }

      setAnimationAssets(generatedAsset);
      setAppState(AppState.Animating);

    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred.');
      setAppState(AppState.Capturing);
    }
  }, [storyPrompt, originalImage]);
  
  useEffect(() => {
    if (originalImage && shouldAnimateAfterCapture.current) {
        shouldAnimateAfterCapture.current = false;
        handleCreateAnimation();
    }
  }, [originalImage, handleCreateAnimation]);
  
  useEffect(() => {
    if (storyPromptTextareaRef.current) {
      const textarea = storyPromptTextareaRef.current;
      if (isPromptFocused) {
        // Expand on focus
        textarea.style.height = 'auto';
        textarea.style.height = `${textarea.scrollHeight}px`;
      } else {
        // Shrink on blur
        textarea.style.height = ''; // Reverts to CSS-defined height
      }
    }
  }, [storyPrompt, isPromptFocused]);

  const handleCapture = useCallback((imageDataUrl: string) => {
    setOriginalImage(imageDataUrl);
    setIsCameraOpen(false);
  }, []);

  const handleFlipCamera = () => {
    cameraViewRef.current?.flipCamera();
  };

  const handleCameraError = useCallback((message: string) => {
    setError(message);
    setAppState(AppState.Error);
  }, []);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setOriginalImage(reader.result as string);
      };
      reader.onerror = () => {
        console.error("Failed to read file");
        setError("Failed to read the selected image file.");
        setAppState(AppState.Error);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleClearImage = () => {
    setOriginalImage(null);
    setIsCameraOpen(false);
    if(fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };
  
  const handleBack = () => {
    setAppState(AppState.Capturing);
    setAnimationAssets(null);
  };
  
  const handleSuggestionClick = (prompt: string) => {
    setStoryPrompt(currentPrompt => {
      if (ALLOW_MULTIPLE_EMOJI_SELECTION) {
        const hasPrompt = currentPrompt.includes(prompt);
        if (hasPrompt) {
          // Remove the prompt and clean up whitespace
          return currentPrompt
            .replace(prompt, '')
            .replace(/\s\s+/g, ' ') // Replace multiple spaces with a single one
            .trim();
        } else {
          // Add the prompt
          return (currentPrompt ? `${currentPrompt} ${prompt}` : prompt).trim();
        }
      } else {
        // Single selection mode: if the current prompt is the one clicked, clear it.
        // Otherwise, replace the current prompt with the clicked one.
        return currentPrompt === prompt ? '' : prompt;
      }
    });
  };
  
  const handlePrimaryAction = useCallback(() => {
    if (isCameraOpen) {
        if (cameraViewRef.current) {
            shouldAnimateAfterCapture.current = true;
            cameraViewRef.current.capture();
        }
    } else {
        handleCreateAnimation();
    }
  }, [isCameraOpen, handleCreateAnimation]);
  
  const isBananimateDisabled = !isCameraOpen && !originalImage && (REQUIRE_IMAGE_FOR_ANIMATION || !storyPrompt.trim());

  const renderContent = () => {
    switch (appState) {
      case AppState.Capturing:
        return (
          <div className="flex flex-col items-center justify-center w-full max-w-md mx-auto">
             <div className="w-full mt-3 mb-2 overflow-x-auto no-scrollbar" aria-label="Animation style suggestions">
                <div className="w-max mx-auto flex items-center gap-x-3 sm:gap-x-4 px-4">
                  {promptSuggestions.map(({ emoji, prompt }) => {
                    const isActive = ALLOW_MULTIPLE_EMOJI_SELECTION
                      ? storyPrompt.includes(prompt)
                      : storyPrompt === prompt;
                    
                    const ariaLabelAction = ALLOW_MULTIPLE_EMOJI_SELECTION
                      ? (isActive ? 'Remove' : 'Add')
                      : (isActive ? 'Deselect' : 'Select');
                      
                    return (
                      <button
                        key={emoji}
                        onClick={() => handleSuggestionClick(prompt)}
                        className={`text-3xl p-2 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500 ${isActive ? 'bg-indigo-600' : 'hover:bg-gray-800'}`}
                        title={prompt}
                        aria-label={`${ariaLabelAction} animation prompt: ${prompt}`}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                </div>
            </div>
            <div className="w-full mb-4 relative">
              {/* A 'fake' placeholder is used because the native placeholder attribute doesn't support newlines. */}
              {!storyPrompt && !isPromptFocused && (
                <div className="absolute top-0 left-0 px-4 py-3 text-gray-400 text-lg pointer-events-none" aria-hidden="true">
                  What would you like to <span className="text-yellow-400">Bananimate</span>?<br />
                  <span className="text-gray-500">
                    {typedPlaceholder}
                    <span className="animate-pulse font-normal">|</span>
                  </span>
                </div>
              )}
              <textarea
                ref={storyPromptTextareaRef}
                id="storyPrompt"
                rows={3}
                className="w-full bg-gray-800 text-white border border-gray-600 rounded-lg px-4 py-3 focus:ring-indigo-500 focus:border-indigo-500 transition-all duration-300 text-lg resize-none overflow-y-auto"
                value={storyPrompt}
                onChange={e => setStoryPrompt(e.target.value)}
                onFocus={() => setIsPromptFocused(true)}
                onBlur={() => {
                  // We add a small delay to allow click events on other elements to fire before the blur causes a layout shift.
                  setTimeout(() => setIsPromptFocused(false), 150);
                }}
                aria-label="Animation prompt"
              />
            </div>

            {error && (
              <div className="w-full bg-red-900/50 border border-red-700 text-red-100 px-4 py-3 rounded-lg relative mb-4 flex items-center justify-between animate-shake" role="alert">
                <div className="pr-4">
                  <strong className="font-bold block">Ohoh Bananimate couldn't Bananimate that one. Try again possibly with a new image and prompt ...?</strong>
                </div>
                <button
                  onClick={() => setError(null)}
                  className="p-1 -mr-2 flex-shrink-0"
                  aria-label="Close error message"
                >
                  <XCircleIcon className="w-6 h-6" />
                </button>
              </div>
            )}
            
            <div className="relative w-full [@media(max-height:750px)]:w-96 [@media(max-height:650px)]:w-72 aspect-square bg-gray-900 rounded-lg overflow-hidden shadow-2xl flex items-center justify-center">
              {originalImage ? (
                  <>
                      <img src={originalImage} alt="Preview" className="w-full h-full object-cover" />
                      <button
                        onClick={handleClearImage}
                        className="absolute top-4 left-4 bg-black/50 p-2 rounded-full text-white hover:bg-black/75 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500"
                        aria-label="Remove image"
                      >
                        <XCircleIcon className="w-6 h-6" />
                      </button>
                  </>
              ) : isCameraOpen ? (
                  <>
                      <CameraView ref={cameraViewRef} onCapture={handleCapture} onError={handleCameraError} />
                       <button
                          onClick={() => setIsCameraOpen(false)}
                          className="absolute top-4 left-4 bg-black/50 p-2 rounded-full text-white hover:bg-black/75 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500"
                          aria-label="Close camera"
                      >
                        <XCircleIcon className="w-6 h-6" />
                      </button>
                      {hasMultipleCameras && (
                          <button
                              onClick={handleFlipCamera}
                              className="absolute top-4 right-4 bg-black/50 p-2 rounded-full text-white hover:bg-black/75 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500"
                              aria-label="Flip camera"
                          >
                              <SwitchCameraIcon className="w-6 h-6" />
                          </button>
                      )}
                  </>
              ) : (
                <div className="flex flex-col items-center justify-center h-full w-full pb-32">
                  <p className="mb-4 text-gray-400 text-lg">
                    {REQUIRE_IMAGE_FOR_ANIMATION ? 'Add an image to Bananimate' : 'Optionally, add an image to Bananimate'}
                  </p>
                  <div className="flex flex-col items-center gap-4">
                    <button
                      onClick={() => setIsCameraOpen(true)}
                      className="w-52 bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-indigo-500 transition-colors duration-300 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500"
                      aria-label="Use camera to take a photo"
                    >
                      <CameraIcon className="w-6 h-6 mr-3" />
                      Open Camera
                    </button>
                    <button
                      onClick={handleUploadClick}
                      className="w-52 bg-gray-700 text-white font-bold py-3 px-6 rounded-lg hover:bg-gray-600 transition-colors duration-300 flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500"
                      aria-label="Upload an image from your device"
                    >
                      <UploadIcon className="w-6 h-6 mr-3" />
                      Upload Image
                    </button>
                  </div>
                </div>
              )}
              {/* Button is now positioned over the image/camera view */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
                <BanamimatorButton
                  onClick={handlePrimaryAction}
                  disabled={isBananimateDisabled}
                  aria-label={isCameraOpen ? 'Capture and Animate' : 'Create Animation'}
                />
              </div>
            </div>
            
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
              accept="image/*"
            />
          </div>
        );
      case AppState.Processing:
        return <LoadingOverlay />;
      case AppState.Animating:
        return animationAssets ? <AnimationPlayer assets={animationAssets} onRegenerate={() => handleCreateAnimation(true)} onBack={handleBack} /> : null;
      case AppState.Error:
        return (
          <div className="text-center bg-red-900/50 p-8 rounded-lg max-w-md w-full">
            <p className="text-gray-200 mb-6 font-medium text-lg">{error}</p>
            <button
              onClick={handleBack}
              className="bg-indigo-600 text-white font-bold py-3 px-6 rounded-lg hover:bg-indigo-500 transition-colors duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-black focus-visible:ring-indigo-500"
            >
              Try Again
            </button>
          </div>
        );
    }
  };

  return (
    <div className="h-dvh bg-black text-gray-100 flex flex-col items-center p-4 overflow-y-auto">
      <div className="w-full grow flex items-center [@media(max-height:750px)]:items-start justify-center">
        {renderContent()}
      </div>
      <footer className="w-full shrink-0 p-4 text-center text-gray-500 text-xs">
        Built with Gemini 2.5 Flash Image Preview | Created by <a href="http://x.com/pitaru" target="_blank" rel="noopener noreferrer" className="underline hover:text-indigo-400">@pitaru</a>
      </footer>
    </div>
  );
};

export default App;