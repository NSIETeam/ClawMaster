/**
 * Panel copy, kept small on purpose: the voice panel is an instrument, and every extra sentence is a
 * sentence the user has to read while a meeting is running.
 */
export interface VoiceCopy {
  tab: string;
  tabDescription: string;
  start: string;
  stop: string;
  recording: string;
  idle: string;
  turns: string;
  speakers: string;
  listening: string;
  notSupported: string;
  engineMissing: string;
  sessionTitle: string;
  titlePlaceholder: string;
  rename: string;
  renameHint: string;
  mergeHint: string;
  enroll: string;
  enrollHint: string;
  enrolled: string;
  noTurns: string;
  problem: string;
  models: string;
}

const ZH: VoiceCopy = {
  tab: '语音',
  tabDescription: '录音、实时转写与说话人分离',
  start: '开始录音',
  stop: '停止录音',
  recording: '录音中',
  idle: '未在录音',
  turns: '已转写',
  speakers: '说话人',
  listening: '正在听…',
  notSupported: '这个环境没有可用的麦克风接口。',
  engineMissing: '语音引擎没有就绪：',
  sessionTitle: '会议标题',
  titlePlaceholder: '例如：产品评审',
  rename: '改名',
  renameHint: '把「说话人 2」改成真名，已记录的句子会一起跟随。',
  mergeHint: '如果聚类把一个人拆成了两个，把其中一个并到另一个。',
  enroll: '记住这个声音',
  enrollHint: '录 10 秒这个人单独说话，之后的会议会自动认出来。',
  enrolled: '已登记声纹',
  noTurns: '还没有转写内容。',
  problem: '上一次投递失败',
  models: '模型',
};

const EN: VoiceCopy = {
  tab: 'Voice',
  tabDescription: 'Recording, live transcription and speaker separation',
  start: 'Start recording',
  stop: 'Stop recording',
  recording: 'Recording',
  idle: 'Not recording',
  turns: 'Turns',
  speakers: 'Speakers',
  listening: 'Listening…',
  notSupported: 'This environment exposes no microphone interface.',
  engineMissing: 'The speech engine is not ready: ',
  sessionTitle: 'Meeting title',
  titlePlaceholder: 'e.g. Product review',
  rename: 'Rename',
  renameHint: 'Turn "说话人 2" into a real name; turns already recorded follow it.',
  mergeHint: 'If clustering split one person in two, merge one into the other.',
  enroll: 'Remember this voice',
  enrollHint: 'Record ten seconds of that person alone and later meetings recognize them.',
  enrolled: 'Enrolled voiceprints',
  noTurns: 'Nothing transcribed yet.',
  problem: 'The last post failed',
  models: 'Models',
};

/** The copy for one locale tag. */
export function voiceCopy(locale: string): VoiceCopy {
  return locale.startsWith('zh') ? ZH : EN;
}
