(function () {
    'use strict';

    function stop(video, stream, frameId) {
        if (frameId !== null) cancelAnimationFrame(frameId);
        if (stream) stream.getTracks().forEach((track) => track.stop());
        if (video) {
            video.pause();
            video.srcObject = null;
        }
    }

    async function start(video, onDetected, onError) {
        let stream = null;
        let frameId = null;
        let stopped = false;
        let detecting = false;

        const stopScanner = () => {
            if (stopped) return;
            stopped = true;
            stop(video, stream, frameId);
        };

        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Este navegador não permite acessar a câmera. Use HTTPS ou localhost.');
            }
            if (!('BarcodeDetector' in window)) {
                throw new Error('A leitura pela câmera não é compatível com este navegador. Digite o código ou use um leitor USB.');
            }

            const formatosSuportados = await window.BarcodeDetector.getSupportedFormats();
            const formatos = ['ean_8', 'ean_13', 'upc_a', 'upc_e', 'itf', 'code_128', 'code_39']
                .filter((formato) => formatosSuportados.includes(formato));
            if (formatos.length === 0) {
                throw new Error('Este navegador não oferece formatos de código de barras compatíveis.');
            }
            const detector = new window.BarcodeDetector({ formats: formatos });
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: 'environment' } },
            });
            video.srcObject = stream;
            await video.play();

            const procurar = async () => {
                if (stopped) return;
                if (!detecting && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                    detecting = true;
                    try {
                        const resultados = await detector.detect(video);
                        if (!stopped && resultados.length > 0) {
                            onDetected(resultados[0].rawValue);
                        }
                    } catch (error) {
                        stopScanner();
                        onError(error);
                        return;
                    } finally {
                        detecting = false;
                    }
                }
                if (!stopped) frameId = requestAnimationFrame(procurar);
            };

            frameId = requestAnimationFrame(procurar);
            return { stop: stopScanner };
        } catch (error) {
            stop(video, stream, frameId);
            throw error;
        }
    }

    window.HydraBarcodeScanner = { start };
})();
