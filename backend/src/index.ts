import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import path, { resolve } from 'path';
import fs from 'fs';
import { promisify } from 'util'; // For fs.unlink

const unlinkAsync = promisify(fs.unlink); //promisify fs.unlink for async cleanup

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Video download endpoint (REMOVED - INTEGRATED INTO /api/clip)
// app.post('/api/download', aync (req, res) => { ... });

//Combined video download and clipping endpoint
app.post('/api/clip', async (req, res) => {
    const timestamp = Date.now();
    // Temporary base name for downloaded streams
    const tempMuxedPathBase = path.join(uploadsDir, `temp-muxed-${timestamp}`);
    let tempMuxedPath: string | null = null; // Full path including extension

    // Final output path for clipped file
    const finalOutputPath = path.join(uploadsDir, `clip-${timestamp}.mp4`);

    try {
        const { url, startTime, endTime } = req.body;

        // Validate inputs
        if (!url || !startTime || !endTime) {
            return res.status(400).json({
                error: 'URL is required'
            });
        }
        // Todo: ADD more robust validation for startTime and EndTime fromats (e.g, HH:MM:SS.ms)

        console.log(`Attempting to download muxed video/audio for cliping from ${url}`);
        console.log(`Using temporary muxed base: ${tempMuxedPathBase}`);

        // --- Step-1: Download muxed video-audio with yt-dlp (only the desired segment) ---
        const runYtDlpDownload = (outputPathBase: string, startTime: string, endTime: string): Promise<string> => {
            return new Promise<string>((resolve, reject) => {
                const outputPathTemplate = outputPathBase + '.%(ext)s';
                let detectedPath: string | null = null;
                console.log(`Starting yt-dlp partial download for muxed format to template '${outputPathTemplate}'`);

                // Format the download section stirng for yt-dlp
                const section = `*${startTime}-${endTime}`;

                const ytDlp = spawn('yt-dlp', [
                    url,
                    '-f', 'bestvideo+bestaudio/best',
                    '--download-sections', section,
                    '-o', outputPathTemplate,
                    '--no-check-certificates',
                    '--no-warnings',
                    '--add-header', 'referer:youtube.com',
                    '--add-header', 'user-agent:Mozilla/5.0',
                    '--merge-output-format', 'mp4',
                    '--verbose',
                ]);

                let processStderr = '';
                ytDlp.stderr.on('data', (data) => {
                    console.error(`yt-dlp stderr (muxed): ${data}`);
                    processStderr += data.toString();
                })

                let processStdout = '';
                ytDlp.stdout.on('data', (data) => {
                    const output = data.toString();
                    console.log(`yt-dlp stdout (muxed): ${output}`);
                    processStdout += output;
                    // Look for destination message
                    const destinationMatch = output.match(/\[downlaod\] Destination: (.+)/);
                    if (destinationMatch && destinationMatch[1]) {
                        const filePath = destinationMatch[1].trim();
                        if (filePath.startsWith(outputPathBase)) {
                            console.log(`Detected download destination (muxed): ${filePath}`);
                            detectedPath = filePath;
                        }
                    }
                });

                ytDlp.on('close', (code) => {
                    if (code === 0) {
                        if (detectedPath && fs.existsSync(detectedPath)) {
                            console.log(`yt-dlp download successful (muxed): ${detectedPath}`);
                            resolve(detectedPath);
                            return;
                        }
                        // IF not detected, try finding file matching the base name
                        console.log(`Could not determine output file from stdout (muxed), attempting to find files...`);
                        try {
                            const files = fs.readdirSync(uploadsDir);
                            const foundFile = files.find(f => f.startsWith(path.basename(outputPathBase)));
                            if (foundFile) {
                                const fullPath = path.join(uploadsDir, foundFile);
                                if (fs.existsSync(fullPath)) {
                                    console.log(`Found downloaded file (muxed) by searching: ${fullPath}`);
                                    resolve(fullPath);
                                    return;
                                }
                            }
                        } catch (findErr) {
                            console.error(`Error searching for downloaded file (muxed):`, findErr);
                        }
                        console.error(`yt-dlp process (muxed) exited code 0 but no output file found.`);
                        reject(new Error(`yt-dlp (muxed) indicated success, but no output file was found. Stderr: ${processStderr}`));
                    } else {
                        console.error(`yt-dlp process (muxed) exited with code ${code}. Stderr: ${processStderr}`);
                        reject(new Error(`yt-dlp download (muxed) failed with code ${code}. Stderr: ${processStderr}`));
                    }
                });

                ytDlp.on('error', (err) => {
                    console.error(`Failed to start yt-dlp process (muxed):`, err);
                    reject(new Error(`Failed to start yt-dlp (muxed): ${err.message}`));
                });
            });
        };

        // Download muxed file (only the segment)
        try {
            tempMuxedPath = await runYtDlpDownload(tempMuxedPathBase, startTime, endTime);
        } catch (downloadError) {
            console.error('yt-dlp muxed download failed.', downloadError);
            throw downloadError;
        }

        // --- Step 2: Optionally, do a final trim with FFmpeg for frame accuracy ---
        if (!tempMuxedPath) {
            throw new Error('Missing temporary muxed path after download.');
        }

        // If you want to skip FFmpeg and just return the yt-dlp output, you can do so here.
        // But for frame-accurate trimming, use FFmpeg as before:
        console.log(`Clipping muxed file (${tempMuxedPath}) from ${startTime} to ${endTime} into ${finalOutputPath}`);

        const ffmpeg = spawn('ffmpeg', [
            '-i', tempMuxedPath,
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-y',
            finalOutputPath
        ]);

        let ffmpegStderr = '';
        ffmpeg.stderr.on('data', (data) => {
            console.log(`ffmpeg: ${data}`);
            ffmpegStderr += data.toString();
        });

        await new Promise<void>((resolve, reject) => {
            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    if (fs.existsSync(finalOutputPath) && fs.statSync(finalOutputPath).size > 0) {
                        console.log('FFmpeg remuz successful.');
                        resolve();
                    } else {
                        console.error(`FFmpeg exited code 0 but output file missing or empty: ${finalOutputPath}`);
                        reject(new Error(`FFmpeg remux failed: Output file missing or empty. Stderr: ${ffmpegStderr}`));
                    }
                } else {
                    console.error(`FFmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
                    reject(new Error(`FFmpeg remux failed with code ${code}. Stderr: ${ffmpegStderr}`));
                }
            });
            ffmpeg.on('error', (err) => {
                console.error('Failed to start ffmpeg process:', err);
                reject(new Error(`Failed to start ffmpeg: ${err.message}`));
            });
        });

        console.log(`Processing complete. Final clip available at: ${finalOutputPath}`);

        // Send the path of the final clipped video back to the client
        res.json({
            success: true,
            filePath: finalOutputPath,
            message: 'Video section processed successfully'
        });

    } catch (error) {
        console.error('Error processing video section:', error);
        res.status(500).json({
            error: 'Failed to process video section',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    } finally {
        // --- Cleanup Temporary Full Files ---
        const CleanupPromises: Promise<void>[] = [];
        if (tempMuxedPath && fs.existsSync(tempMuxedPath)) {
            console.log(`Cleaning up temporary muxed file: ${tempMuxedPath}`);
            CleanupPromises.push(unlinkAsync(tempMuxedPath).catch(err => console.error(`Failed to delete temp muxed: ${err}`)));
        }
        const partFilePath = finalOutputPath + '.part';
        if (fs.existsSync(partFilePath)) {
            console.log(`Cleaning up partial ffmpeg output: ${partFilePath}`);
            CleanupPromises.push(unlinkAsync(partFilePath).catch(err => console.error(`Failed to delete partial file: ${err}`)));
        }
        await Promise.all(CleanupPromises);
        console.log('Temporary file cleanup finished.');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});