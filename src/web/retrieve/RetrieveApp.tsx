import { useState, useEffect } from 'react';
import { RetrieveClient } from '@/components/RetrieveClient';
import { readCodeFromLocation } from '@/lib/share';

export default function RetrieveApp() {
	const [retrievalCode, setRetrievalCode] = useState('');
	const [showFiles, setShowFiles] = useState(false);

	// The code travels in the URL fragment (/retrieve/#ABC123), which is never sent to the server
	useEffect(() => {
		const syncFromLocation = () => {
			const code = readCodeFromLocation();
			if (code) {
				setRetrievalCode(code);
				setShowFiles(true);
			} else {
				setRetrievalCode('');
				setShowFiles(false);
			}
		};

		syncFromLocation();
		window.addEventListener('hashchange', syncFromLocation);
		return () => window.removeEventListener('hashchange', syncFromLocation);
	}, []);

	const handleRetrieve = () => {
		const code = retrievalCode.trim();
		if (!code) {
			alert('Please enter a retrieval code');
			return;
		}

		if (code.length !== 6) {
			alert('Retrieval code must be exactly 6 characters');
			return;
		}

		// Update URL and show files
		window.history.pushState({}, '', `/retrieve/#${code}`);
		setShowFiles(true);
	};

	const handleKeyPress = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			handleRetrieve();
		}
	};

	const handleBack = () => {
		window.history.pushState({}, '', '/retrieve/');
		setShowFiles(false);
		setRetrievalCode('');
	};

	if (showFiles && retrievalCode) {
		return <RetrieveClient key={retrievalCode} code={retrievalCode} onBack={handleBack} />;
	}

	return (
		<main className="min-h-screen bg-linear-to-br from-green-50 via-white to-emerald-50 flex items-center justify-center p-4">
			<div className="max-w-md w-full">
				<div className="text-center mb-8">
					<a href="/" className="text-green-600 hover:text-green-800 text-sm">
						← Back to Home
					</a>
					<div className="text-8xl mb-6 mt-4">📥</div>
					<h1 className="text-4xl font-bold text-gray-900 mb-4">Retrieve Files</h1>
					<p className="text-xl text-gray-600">Enter your 6-character retrieval code to access shared files</p>
				</div>

				<div className="bg-white rounded-2xl shadow-lg p-8">
					<div className="space-y-6">
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-3">Retrieval Code</label>
							<input
								type="text"
								value={retrievalCode}
								onChange={(e) => setRetrievalCode(e.target.value.toUpperCase())}
								onKeyPress={handleKeyPress}
								placeholder="A1B2C3"
								maxLength={6}
								className="w-full p-4 text-center text-2xl font-mono font-bold border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors"
							/>
							<div className="flex justify-between items-center mt-2">
								<p className="text-xs text-gray-500">Enter the 6-character code (letters and numbers)</p>
								<p
									className={`text-xs ${
										retrievalCode.length === 6 ? 'text-green-600' : retrievalCode.length > 6 ? 'text-red-600' : 'text-gray-400'
									}`}
								>
									{retrievalCode.length}/6
								</p>
							</div>
						</div>

						<button
							onClick={handleRetrieve}
							disabled={!retrievalCode.trim() || retrievalCode.trim().length !== 6}
							className="w-full py-4 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed font-semibold text-lg transition-colors"
						>
							Access Files
						</button>

						<div className="text-center">
							<p className="text-sm text-gray-500">
								Don't have a code?{' '}
								<a href="/upload/" className="text-green-600 hover:text-green-800 font-medium">
									Share files instead
								</a>
							</p>
						</div>
					</div>
				</div>

				<div className="mt-8 text-center">
					<div className="bg-white rounded-lg p-4 shadow-sm">
						<h3 className="font-medium text-gray-900 mb-2">How it works:</h3>
						<div className="text-sm text-gray-600 space-y-1">
							<p>• Enter the 6-character code you received</p>
							<p>• View and download all shared files</p>
							<p>• Files expire after the set time period</p>
						</div>
					</div>
				</div>
			</div>
		</main>
	);
}
